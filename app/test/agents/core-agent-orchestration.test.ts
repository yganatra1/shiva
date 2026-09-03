import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentOrchestratorPort,
  AgentRequest,
  AgentRunResult,
} from "../../src/agent/types.js";
import {
  AgentDelegationError,
} from "../../src/agents/agent-client.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import {
  AgentTaskDispatcher,
  type AgentTaskPublisher,
  type DurableDelegationOptions,
} from "../../src/agents/agent-task-dispatcher.js";
import {
  MAX_TASKS_PER_AGENT_PER_REQUEST,
  OrchestrationRepositoryError,
  type AcceptedAgentResponse,
  type AgentResponseRecord,
  type AgentTaskRecord,
  type CompleteRequestAfterConfirmationInput,
  type CreateInitialRequestWithTaskInput,
  type CreateNextTaskInput,
  type FinishResponseWithMessageInput,
  type OrchestrationAssistantMessage,
  type OrchestrationRepositoryPort,
  type OrchestrationRequestRecord,
  type PlainAgentResponseEnvelope,
} from "../../src/agents/orchestration-repository.js";
import type {
  AgentResponse,
  AgentTask,
} from "../../src/agents/shared/protocol.js";
import {
  CoreAgentResponseProcessor,
  type CoreAgentResponseProcessorOptions,
} from "../../src/core/agent-response-processor.js";
import type {
  CoreUpdate,
  CoreUpdatePublisher,
} from "../../src/core/core-update-hub.js";
import type { StoredMessage } from "../../src/memory/types.js";

const NOW = new Date("2026-08-24T10:00:00.000Z");
const DEVICE_RESPONSE_AT = "2026-08-24T10:00:10.000Z";
const GOOGLE_RESPONSE_AT = "2026-08-24T10:00:20.000Z";
const ORIGINAL_REQUEST =
  "Call Mom and if she doesn't answer then add ₹500 in expense.";
const EXECUTION_CONTEXT = [
  "Resolve Mom and ask Device Agent to call her.",
  "If she does not answer, ask Google Agent to add ₹500 to the expense sheet.",
].join("\n");

test("dispatcher persists executionContext verbatim before publishing a minimal task", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher(["device-agent"]);
  const dispatcher = createDispatcher(repository, publisher, [
    "device-task-1",
    "request-1",
  ]);

  const delegated = await dispatcher.delegate(
    "device-agent",
    "Call Mom at +91XXXXXXXXXX. Report whether the call was answered.",
    {
      orchestration: initialOrchestration({
        conversationId: "conversation-1",
        sourceMessageId: "source-message-1",
        executionContext: EXECUTION_CONTEXT,
      }),
    },
  );

  assert.deepEqual(delegated, {
    queued: true,
    requestId: "request-1",
    taskId: "device-task-1",
    userMessage: "I've asked Device Agent to handle that.",
  });
  assert.equal(
    repository.requests.get("request-1")?.executionContext,
    EXECUTION_CONTEXT,
  );
  assert.equal(repository.initialInputs[0]?.executionContext, EXECUTION_CONTEXT);
  assert.deepEqual(publisher.published, [
    {
      id: "device-task-1",
      conversationId: "conversation-1",
      agentId: "device-agent",
      instruction:
        "Call Mom at +91XXXXXXXXXX. Report whether the call was answered.",
      createdAt: NOW.toISOString(),
      deadlineAt: "2026-08-24T10:00:30.000Z",
    },
  ]);
  assert.deepEqual(Object.keys(publisher.published[0] ?? {}).sort(), [
    "agentId",
    "conversationId",
    "createdAt",
    "deadlineAt",
    "id",
    "instruction",
  ]);
  assert.equal("executionContext" in (publisher.published[0] ?? {}), false);
  assert.equal("status" in (publisher.published[0] ?? {}), false);
});

test("dispatcher gives developer work its configured longer task deadline", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher(["developer-agent"]);
  const dispatcher = createDispatcher(
    repository,
    publisher,
    ["developer-task-1", "request-1"],
    { "developer-agent": 2_100_000 },
  );

  await dispatcher.delegate(
    "developer-agent",
    "Implement and validate the requested repository change.",
    { orchestration: initialOrchestration() },
  );

  assert.equal(
    publisher.published[0]?.deadlineAt,
    new Date(NOW.getTime() + 2_100_000).toISOString(),
  );
});

test("unknown and offline agents fail with controlled delegation errors", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher();
  const dispatcher = createDispatcher(repository, publisher, []);
  const options = {
    orchestration: initialOrchestration(),
  } as const;

  await assert.rejects(
    dispatcher.delegate("unknown-agent", "Do the thing.", options),
    (error: unknown) =>
      error instanceof AgentDelegationError &&
      error.failure === "AGENT_NOT_FOUND",
  );
  await assert.rejects(
    dispatcher.delegate("device-agent", "Call Mom.", options),
    (error: unknown) =>
      error instanceof AgentDelegationError && error.failure === "AGENT_OFFLINE",
  );

  assert.equal(repository.requests.size, 0);
  assert.equal(repository.tasks.size, 0);
  assert.deepEqual(publisher.published, []);
});

test("response correlation keeps two concurrent natural-language contexts isolated", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher(["device-agent"]);
  const dispatcher = createDispatcher(repository, publisher, [
    "task-a",
    "request-a",
    "task-b",
    "request-b",
  ]);
  const contextA = "Call Alice, then record only Alice's outcome.";
  const contextB = "Call Bob, then record only Bob's outcome.";

  await dispatcher.delegate("device-agent", "Call Alice at +910000000001.", {
    orchestration: initialOrchestration({
      conversationId: "conversation-a",
      sourceMessageId: "source-a",
      originalUserRequest: "Call Alice.",
      executionContext: contextA,
    }),
  });
  await dispatcher.delegate("device-agent", "Call Bob at +910000000002.", {
    orchestration: initialOrchestration({
      conversationId: "conversation-b",
      sourceMessageId: "source-b",
      originalUserRequest: "Call Bob.",
      executionContext: contextB,
    }),
  });

  const orchestrator = new ConcurrentEchoOrchestrator(2);
  const updates = new RecordingUpdates();
  const processor = createResponseProcessor(repository, orchestrator, updates);
  await Promise.all([
    processor.processResponse(
      plainResponse("task-a", "Alice did not answer.", DEVICE_RESPONSE_AT),
      "response-stream-a",
    ),
    processor.processResponse(
      plainResponse("task-b", "Bob answered the call.", DEVICE_RESPONSE_AT),
      "response-stream-b",
    ),
  ]);

  const continuationByRequest = new Map(
    orchestrator.requests.map((request) => [
      request.delegationContinuation?.requestId,
      request.delegationContinuation,
    ]),
  );
  assert.deepEqual(continuationByRequest.get("request-a"), {
    requestId: "request-a",
    responseId: repository.responseIdForTask("task-a"),
    originalUserRequest: "Call Alice.",
    executionContext: contextA,
    latestAgentResponse: "Alice did not answer.",
  });
  assert.deepEqual(continuationByRequest.get("request-b"), {
    requestId: "request-b",
    responseId: repository.responseIdForTask("task-b"),
    originalUserRequest: "Call Bob.",
    executionContext: contextB,
    latestAgentResponse: "Bob answered the call.",
  });
  assert.deepEqual(
    updates.values
      .map(({ conversationId, message }) => ({ conversationId, message }))
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
    [
      {
        conversationId: "conversation-a",
        message: `${contextA} Latest report: Alice did not answer.`,
      },
      {
        conversationId: "conversation-b",
        message: `${contextB} Latest report: Bob answered the call.`,
      },
    ],
  );
});

test("Core continues Device to Google from prose context and then completes for the user", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher([
    "device-agent",
    "google-agent",
  ]);
  const dispatcher = createDispatcher(repository, publisher, [
    "device-task",
    "main-request",
    "google-task",
  ]);
  const initial = await dispatcher.delegate(
    "device-agent",
    "Call Mom at +91XXXXXXXXXX. Report whether the call was answered.",
    {
      orchestration: initialOrchestration({
        userMessage: "I've asked the Device Agent to call Mom.",
      }),
    },
  );
  const orchestrator = new DeviceThenGoogleOrchestrator(dispatcher);
  const updates = new RecordingUpdates();
  const processor = createResponseProcessor(repository, orchestrator, updates);
  const deviceResponse = plainResponse(
    initial.taskId,
    "Mom did not answer the call.",
    DEVICE_RESPONSE_AT,
  );

  assert.deepEqual(Object.keys(deviceResponse).sort(), [
    "agentId",
    "message",
    "taskId",
    "timestamp",
  ]);
  assert.equal("status" in deviceResponse, false);
  await processor.processResponse(deviceResponse, "device-response-stream-id");

  assert.deepEqual(publisher.published[1], {
    id: "google-task",
    conversationId: "conversation-1",
    agentId: "google-agent",
    instruction: "Add ₹500 to the expense sheet and report the result.",
    createdAt: new Date("2026-08-24T10:00:11.000Z").toISOString(),
    deadlineAt: "2026-08-24T10:00:41.000Z",
  });
  assert.equal(repository.nextInputs[0]?.requestId, "main-request");
  assert.equal(
    repository.nextInputs[0]?.createdFromResponseId,
    repository.responseIdForTask("device-task"),
  );

  const googleResponse: AgentResponse = {
    taskId: "google-task",
    agentId: "google-agent",
    message: "₹500 has been added to the expense sheet successfully.",
    timestamp: GOOGLE_RESPONSE_AT,
  };
  assert.equal("status" in googleResponse, false);
  await processor.processResponse(googleResponse, "google-response-stream-id");

  assert.deepEqual(
    orchestrator.requests.map((request) => ({
      executionContext: request.delegationContinuation?.executionContext,
      latestAgentResponse:
        request.delegationContinuation?.latestAgentResponse,
    })),
    [
      {
        executionContext: EXECUTION_CONTEXT,
        latestAgentResponse: "Mom did not answer the call.",
      },
      {
        executionContext: EXECUTION_CONTEXT,
        latestAgentResponse:
          "₹500 has been added to the expense sheet successfully.",
      },
    ],
  );
  assert.deepEqual(
    repository.finishInputs.map(({ requestId, complete }) => ({
      requestId,
      complete,
    })),
    [
      { requestId: "main-request", complete: false },
      { requestId: "main-request", complete: true },
    ],
  );
  assert.deepEqual(updates.values.at(-1), {
    messageId: "assistant-message-2",
    conversationId: "conversation-1",
    message: "Mom didn't answer, so I added ₹500 to the expense sheet.",
    timestamp: GOOGLE_RESPONSE_AT,
  });
  assert.equal(repository.requests.get("main-request")?.completedAt?.toISOString(), GOOGLE_RESPONSE_AT);
});

test("re-delegating to the same failing agent stops after its per-request retry limit instead of looping forever", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher(["device-agent"]);
  const dispatcher = createDispatcher(repository, publisher, [
    "device-task-1",
    "retry-request",
    "device-task-2",
    "device-task-3",
  ]);
  const initial = await dispatcher.delegate(
    "device-agent",
    "Call Mom at +91XXXXXXXXXX. Report whether the call was answered.",
    { orchestration: initialOrchestration() },
  );
  const orchestrator = new AlwaysRetrySameAgentOrchestrator(dispatcher);
  const updates = new RecordingUpdates();
  const processor = createResponseProcessor(repository, orchestrator, updates);

  const firstFailure = plainResponse(
    initial.taskId,
    "Device Agent could not reach Mom: authentication failed.",
    DEVICE_RESPONSE_AT,
  );
  // The first retry is allowed: this is the "one more time" the cap grants.
  await processor.processResponse(firstFailure, "device-response-stream-1");
  assert.equal(orchestrator.requests.length, 1);

  const secondTaskId = repository.nextInputs.at(-1)?.taskId ?? "device-task-2";
  const secondFailure = plainResponse(
    secondTaskId,
    "Device Agent could not reach Mom: authentication failed again.",
    "2026-08-24T10:00:20.000Z",
  );
  // A third attempt at the same agent for this request must be refused, not
  // silently retried again — this is the exact runaway loop being fixed.
  await assert.rejects(
    processor.processResponse(secondFailure, "device-response-stream-2"),
    /already delegated to 'device-agent' 2 time\(s\)/,
  );

  const deviceTasks = [...repository.tasks.values()].filter(
    (task) => task.agentId === "device-agent",
  );
  assert.equal(
    deviceTasks.length,
    2,
    "no third device-agent task should have been created for this request",
  );
});

test("deadline responses complete the request without asking Core to retry uncertain work", async () => {
  for (const transportFailure of [
    "AGENT_TASK_DEADLINE",
    "AGENT_RESPONSE_TIMEOUT",
  ] as const) {
    const repository = new InMemoryOrchestrationRepository();
    const publisher = new InMemoryTaskPublisher(["developer-agent"]);
    const dispatcher = createDispatcher(repository, publisher, [
      `task-${transportFailure}`,
      `request-${transportFailure}`,
    ]);
    const delegated = await dispatcher.delegate(
      "developer-agent",
      "Implement and validate the requested repository change.",
      { orchestration: initialOrchestration() },
    );
    let continuationCalls = 0;
    const processor = createResponseProcessor(
      repository,
      {
        async run() {
          continuationCalls += 1;
          throw new Error("Core must not plan a retry after a task deadline.");
        },
      },
      new RecordingUpdates(),
    );

    await processor.processResponse(
      {
        taskId: delegated.taskId,
        agentId: "developer-agent",
        message: "developer-agent did not finish before its deadline.",
        metadata: { transportFailure },
        timestamp: DEVICE_RESPONSE_AT,
      },
      `response-${transportFailure}`,
    );

    assert.equal(continuationCalls, 0, transportFailure);
    assert.equal(repository.tasks.size, 1, transportFailure);
    assert.equal(repository.finishInputs.at(-1)?.complete, true);
    assert.match(
      repository.messages.at(-1)?.content ?? "",
      /stopped without retrying.*partial changes/i,
    );
  }
});

test("maxProcessingAttempts permits that many real Core continuation attempts", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const publisher = new InMemoryTaskPublisher(["device-agent"]);
  const dispatcher = createDispatcher(repository, publisher, [
    "retry-task",
    "retry-request",
  ]);
  const delegated = await dispatcher.delegate(
    "device-agent",
    "Call Mom and report whether she answered.",
    { orchestration: initialOrchestration() },
  );
  let continuationAttempts = 0;
  const orchestrator: AgentOrchestratorPort = {
    async run() {
      continuationAttempts += 1;
      throw new Error("Synthetic Core planning failure.");
    },
  };
  const updates = new RecordingUpdates();
  const processor = createResponseProcessor(
    repository,
    orchestrator,
    updates,
    3,
  );
  const response = plainResponse(
    delegated.taskId,
    "Mom did not answer the call.",
    DEVICE_RESPONSE_AT,
  );

  await assert.rejects(
    processor.processResponse(response, "retry-response-stream-1"),
    /Synthetic Core planning failure/,
  );
  await assert.rejects(
    processor.processResponse(response, "retry-response-stream-2"),
    /Synthetic Core planning failure/,
  );
  await processor.processResponse(response, "retry-response-stream-3");

  assert.equal(continuationAttempts, 3);
  const responseId = repository.responseIdForTask(delegated.taskId);
  assert.ok(responseId);
  assert.equal(repository.responses.get(responseId)?.processingAttempts, 3);
  assert.equal(repository.finishInputs.at(-1)?.complete, true);
  assert.match(
    repository.messages.at(-1)?.content ?? "",
    /after bounded retries/i,
  );
});

test("repeated Redis loop failures back off exponentially and stop aborts the wait", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const claimTimes: number[] = [];
  let reportThirdError!: () => void;
  const thirdError = new Promise<void>((resolve) => {
    reportThirdError = resolve;
  });
  const transport: CoreAgentResponseProcessorOptions["transport"] = {
    async ensureResponseConsumerGroup() {},
    async claimStaleResponses() {
      claimTimes.push(performance.now());
      throw new Error("Synthetic Redis outage.");
    },
    async readResponses() {
      return [];
    },
    async acknowledgeResponse() {},
  };
  const processor = new CoreAgentResponseProcessor({
    transport,
    repository,
    conversationRepository: {
      async getRecentMessages() {
        return [];
      },
    },
    orchestrator: {
      async run() {
        throw new Error("The orchestrator must not run without a response.");
      },
    },
    updates: new RecordingUpdates(),
    userName: "Test User",
    timeZone: "Asia/Kolkata",
    workingMemoryMessageLimit: 20,
    reclaimIdleMs: 1_000,
    processingLeaseMs: 10_000,
    maxProcessingAttempts: 3,
    onError() {
      if (claimTimes.length === 3) reportThirdError();
    },
  });

  await processor.start();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      thirdError,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Redis backoff test timed out.")),
          2_000,
        );
      }),
    ]);
    assert.equal(claimTimes.length, 3);
    assert.ok((claimTimes[1] ?? 0) - (claimTimes[0] ?? 0) >= 80);
    assert.ok((claimTimes[2] ?? 0) - (claimTimes[1] ?? 0) >= 160);
    const stoppingAt = performance.now();
    await processor.stop();
    assert.ok(performance.now() - stoppingAt < 100);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await processor.stop();
  }
});

class InMemoryTaskPublisher implements AgentTaskPublisher {
  readonly published: AgentTask[] = [];
  private readonly online: Set<string>;
  private nextStreamId = 1;

  constructor(onlineAgentIds: readonly string[] = []) {
    this.online = new Set(onlineAgentIds);
  }

  async publishTask(task: AgentTask): Promise<string> {
    this.published.push({ ...task });
    return `task-stream-${this.nextStreamId++}`;
  }

  async isAgentOnline(agentId: string): Promise<boolean> {
    return this.online.has(agentId);
  }
}

class InMemoryOrchestrationRepository
  implements OrchestrationRepositoryPort
{
  readonly requests = new Map<string, OrchestrationRequestRecord>();
  readonly tasks = new Map<string, AgentTaskRecord>();
  readonly responses = new Map<string, AgentResponseRecord>();
  readonly messages: OrchestrationAssistantMessage[] = [];
  readonly initialInputs: CreateInitialRequestWithTaskInput[] = [];
  readonly nextInputs: CreateNextTaskInput[] = [];
  readonly finishInputs: FinishResponseWithMessageInput[] = [];
  private responseSequence = 0;
  private messageSequence = 0;

  async getRequest(
    requestId: string,
  ): Promise<OrchestrationRequestRecord | undefined> {
    return this.requests.get(requestId);
  }

  async createInitialRequestWithTask(
    input: CreateInitialRequestWithTaskInput,
  ): Promise<{
    readonly request: OrchestrationRequestRecord;
    readonly task: AgentTaskRecord;
  }> {
    this.initialInputs.push(input);
    const requestId = input.requestId ?? `request-${this.requests.size + 1}`;
    const taskId = input.taskId ?? `task-${this.tasks.size + 1}`;
    const request: OrchestrationRequestRecord = {
      id: requestId,
      userId: input.userId,
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      originalUserRequest: input.originalUserRequest,
      executionContext: input.executionContext,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    };
    const task = taskRecord({
      id: taskId,
      orchestrationRequestId: requestId,
      agentId: input.agentId,
      instruction: input.instruction,
      createdAt: input.now,
      deadlineAt: input.deadlineAt,
    });
    this.requests.set(request.id, request);
    this.tasks.set(task.id, task);
    return { request, task };
  }

  async createNextTask(input: CreateNextTaskInput): Promise<AgentTaskRecord> {
    this.nextInputs.push(input);
    const sourceResponse = this.responses.get(input.createdFromResponseId);
    if (!sourceResponse) {
      throw new OrchestrationRepositoryError(
        "RESPONSE_NOT_FOUND",
        "The source response does not exist.",
      );
    }
    const sourceTask = this.tasks.get(sourceResponse.taskId);
    if (sourceTask?.orchestrationRequestId !== input.requestId) {
      throw new OrchestrationRepositoryError(
        "RESPONSE_REQUEST_MISMATCH",
        "The source response belongs to a different request.",
      );
    }
    const existing = [...this.tasks.values()].find(
      (task) => task.createdFromResponseId === input.createdFromResponseId,
    );
    if (existing) return existing;
    const agentTaskCount = [...this.tasks.values()].filter(
      (task) =>
        task.orchestrationRequestId === input.requestId &&
        task.agentId === input.agentId,
    ).length;
    if (agentTaskCount >= MAX_TASKS_PER_AGENT_PER_REQUEST) {
      throw new OrchestrationRepositoryError(
        "DELEGATION_LIMIT_REACHED",
        `This orchestration request has already delegated to '${input.agentId}' ${MAX_TASKS_PER_AGENT_PER_REQUEST} time(s). Do not delegate to '${input.agentId}' again for this request; use the existing agent response(s) to return a grounded answer or failure to the user now.`,
      );
    }
    const task = taskRecord({
      id: input.taskId ?? `task-${this.tasks.size + 1}`,
      orchestrationRequestId: input.requestId,
      agentId: input.agentId,
      instruction: input.instruction,
      createdFromResponseId: input.createdFromResponseId,
      createdAt: input.now,
      deadlineAt: input.deadlineAt,
    });
    this.tasks.set(task.id, task);
    return task;
  }

  async markTaskPublished(
    taskId: string,
    redisMessageId: string,
    now: Date,
  ): Promise<AgentTaskRecord> {
    const task = this.requiredTask(taskId);
    const published: AgentTaskRecord = {
      ...task,
      publishedAt: now,
      redisMessageId,
      deliveryAttempts: task.deliveryAttempts + 1,
      lastDeliveryError: null,
    };
    this.tasks.set(taskId, published);
    return published;
  }

  async listUnpublishedTasks(limit: number): Promise<readonly AgentTaskRecord[]> {
    return [...this.tasks.values()]
      .filter((task) => !task.publishedAt && !task.abandonedAt)
      .slice(0, limit);
  }

  async acceptResponse(
    envelope: PlainAgentResponseEnvelope,
    redisMessageId: string,
  ): Promise<AcceptedAgentResponse> {
    const task = this.tasks.get(envelope.taskId);
    if (!task) {
      throw new OrchestrationRepositoryError(
        "TASK_NOT_FOUND",
        "The response references an unknown task.",
      );
    }
    if (task.agentId !== envelope.agentId) {
      throw new OrchestrationRepositoryError(
        "TASK_AGENT_MISMATCH",
        "The response came from the wrong agent.",
      );
    }
    const request = this.requests.get(task.orchestrationRequestId);
    assert.ok(request);
    const existing = [...this.responses.values()].find(
      (response) => response.taskId === task.id,
    );
    if (existing) {
      return { accepted: false, request, task, response: existing };
    }
    if (task.abandonedAt || request.completedAt) {
      throw new OrchestrationRepositoryError(
        "TASK_NOT_ACTIVE",
        "The response arrived after the task was closed.",
      );
    }
    const timestamp = new Date(envelope.timestamp);
    const response: AgentResponseRecord = {
      id: `accepted-response-${++this.responseSequence}`,
      taskId: task.id,
      agentId: envelope.agentId,
      message: envelope.message,
      metadata: { ...(envelope.metadata ?? {}) },
      agentTimestamp: timestamp,
      receivedAt: timestamp,
      redisMessageId,
      processingStartedAt: null,
      processingAttempts: 0,
      lastProcessingError: null,
      processedAt: null,
      assistantMessageId: null,
    };
    this.responses.set(response.id, response);
    return { accepted: true, request, task, response };
  }

  async listUnprocessedResponses(
    staleBefore: Date,
    limit: number,
  ): Promise<readonly AcceptedAgentResponse[]> {
    return [...this.responses.values()]
      .filter(
        (response) =>
          !response.processedAt &&
          (!response.processingStartedAt ||
            response.processingStartedAt <= staleBefore),
      )
      .slice(0, limit)
      .map((response) => {
        const task = this.requiredTask(response.taskId);
        const request = this.requests.get(task.orchestrationRequestId);
        assert.ok(request);
        return { accepted: false, request, task, response };
      });
  }

  async claimResponseProcessing(
    responseId: string,
    claimedAt: Date,
    staleBefore: Date,
  ): Promise<AcceptedAgentResponse | undefined> {
    const response = this.responses.get(responseId);
    if (
      !response ||
      response.processedAt ||
      (response.processingStartedAt && response.processingStartedAt > staleBefore)
    ) {
      return undefined;
    }
    const claimed: AgentResponseRecord = {
      ...response,
      processingStartedAt: claimedAt,
      processingAttempts: response.processingAttempts + 1,
      lastProcessingError: null,
    };
    this.responses.set(response.id, claimed);
    const task = this.requiredTask(response.taskId);
    const request = this.requests.get(task.orchestrationRequestId);
    assert.ok(request);
    return { accepted: false, request, task, response: claimed };
  }

  async releaseResponseProcessing(
    responseId: string,
    claimedAt: Date,
    error: string,
  ): Promise<void> {
    const response = this.responses.get(responseId);
    if (
      response?.processingStartedAt?.getTime() !== claimedAt.getTime() ||
      response.processedAt
    ) {
      return;
    }
    this.responses.set(response.id, {
      ...response,
      processingStartedAt: null,
      lastProcessingError: error,
    });
  }

  async completeRequestAfterConfirmation(
    input: CompleteRequestAfterConfirmationInput,
  ): Promise<OrchestrationRequestRecord | undefined> {
    const response = this.responses.get(input.responseId);
    if (!response) {
      throw new OrchestrationRepositoryError(
        "RESPONSE_NOT_FOUND",
        "The response does not exist.",
      );
    }
    const task = this.requiredTask(response.taskId);
    if (task.orchestrationRequestId !== input.requestId) {
      throw new OrchestrationRepositoryError(
        "RESPONSE_REQUEST_MISMATCH",
        "The response belongs to a different request.",
      );
    }
    const nextTask = [...this.tasks.values()].find(
      (candidate) => candidate.createdFromResponseId === input.responseId,
    );
    if (nextTask) return undefined;
    const request = this.requests.get(input.requestId);
    assert.ok(request);
    const completed = {
      ...request,
      completedAt: request.completedAt ?? input.now,
      updatedAt: input.now,
    };
    this.requests.set(request.id, completed);
    return completed;
  }

  async finishResponseWithMessage(
    input: FinishResponseWithMessageInput,
  ): Promise<OrchestrationAssistantMessage> {
    this.finishInputs.push(input);
    const response = this.responses.get(input.responseId);
    if (!response) {
      throw new OrchestrationRepositoryError(
        "RESPONSE_NOT_FOUND",
        "The response does not exist.",
      );
    }
    const task = this.requiredTask(response.taskId);
    if (task.orchestrationRequestId !== input.requestId) {
      throw new OrchestrationRepositoryError(
        "RESPONSE_REQUEST_MISMATCH",
        "The response belongs to a different request.",
      );
    }
    if (response.processedAt && response.assistantMessageId) {
      const existing = this.messages.find(
        (message) => message.id === response.assistantMessageId,
      );
      assert.ok(existing);
      return existing;
    }
    const request = this.requests.get(input.requestId);
    assert.ok(request);
    const message: OrchestrationAssistantMessage = {
      id: `assistant-message-${++this.messageSequence}`,
      conversationId: request.conversationId,
      role: "assistant",
      content: input.message,
      createdAt: input.now,
    };
    this.messages.push(message);
    this.responses.set(response.id, {
      ...response,
      processingStartedAt: input.claimedAt,
      processedAt: input.now,
      assistantMessageId: message.id,
    });
    this.requests.set(request.id, {
      ...request,
      updatedAt: input.now,
      completedAt: input.complete ? input.now : request.completedAt,
    });
    return message;
  }

  async listExpiredTasks(
    now: Date,
    limit: number,
  ): Promise<readonly AgentTaskRecord[]> {
    const respondedTaskIds = new Set(
      [...this.responses.values()].map((response) => response.taskId),
    );
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.deadlineAt <= now &&
          !task.abandonedAt &&
          !respondedTaskIds.has(task.id),
      )
      .slice(0, limit);
  }

  async markTaskAbandoned(
    taskId: string,
    reason: string,
    now: Date,
  ): Promise<AgentTaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const abandoned: AgentTaskRecord = {
      ...task,
      abandonedAt: now,
      lastDeliveryError: reason,
    };
    this.tasks.set(taskId, abandoned);
    return abandoned;
  }

  recentMessages(
    conversationId: string,
    limit: number,
  ): readonly StoredMessage[] {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .slice(-limit);
  }

  responseIdForTask(taskId: string): string | undefined {
    return [...this.responses.values()].find(
      (response) => response.taskId === taskId,
    )?.id;
  }

  private requiredTask(taskId: string): AgentTaskRecord {
    const task = this.tasks.get(taskId);
    assert.ok(task);
    return task;
  }
}

class RecordingUpdates implements CoreUpdatePublisher {
  readonly values: CoreUpdate[] = [];

  publish(update: CoreUpdate): void {
    this.values.push(update);
  }
}

class ConcurrentEchoOrchestrator implements AgentOrchestratorPort {
  readonly requests: AgentRequest[] = [];
  private readonly barrier: Promise<void>;
  private releaseBarrier!: () => void;

  constructor(private readonly expectedCalls: number) {
    this.barrier = new Promise<void>((resolve) => {
      this.releaseBarrier = resolve;
    });
  }

  async run(request: AgentRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    if (this.requests.length === this.expectedCalls) this.releaseBarrier();
    await this.barrier;
    const continuation = request.delegationContinuation;
    assert.ok(continuation);
    return {
      kind: "response",
      runId: `run-${continuation.requestId}`,
      response: `${continuation.executionContext} Latest report: ${continuation.latestAgentResponse}`,
      steps: 1,
      observations: [],
    };
  }
}

/** Simulates a planner that keeps retrying the same failing agent on every continuation. */
class AlwaysRetrySameAgentOrchestrator implements AgentOrchestratorPort {
  readonly requests: AgentRequest[] = [];

  constructor(private readonly dispatcher: AgentTaskDispatcher) {}

  async run(request: AgentRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    const continuation = request.delegationContinuation;
    assert.ok(continuation);
    const delegated = await this.dispatcher.delegate(
      "device-agent",
      "Try calling Mom again.",
      {
        orchestration: {
          agentRunId: `continuation-run-${this.requests.length}`,
          conversationId: request.conversationId,
          userId: request.userId,
          orchestrationRequestId: continuation.requestId,
          agentResponseId: continuation.responseId,
          userMessage: "Retrying the call to Mom.",
          now: new Date(
            new Date(DEVICE_RESPONSE_AT).getTime() + this.requests.length,
          ),
        },
      },
    );
    return {
      kind: "delegated",
      runId: `continuation-run-${this.requests.length}`,
      response: delegated.userMessage,
      orchestrationRequestId: delegated.requestId,
      taskId: delegated.taskId,
      steps: 1,
      observations: [],
    };
  }
}

class DeviceThenGoogleOrchestrator implements AgentOrchestratorPort {
  readonly requests: AgentRequest[] = [];

  constructor(private readonly dispatcher: AgentTaskDispatcher) {}

  async run(request: AgentRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    const continuation = request.delegationContinuation;
    assert.ok(continuation);
    assert.equal(continuation.originalUserRequest, ORIGINAL_REQUEST);
    assert.equal(continuation.executionContext, EXECUTION_CONTEXT);

    if (continuation.latestAgentResponse === "Mom did not answer the call.") {
      const delegated = await this.dispatcher.delegate(
        "google-agent",
        "Add ₹500 to the expense sheet and report the result.",
        {
          orchestration: {
            agentRunId: "continuation-run-1",
            conversationId: request.conversationId,
            userId: request.userId,
            orchestrationRequestId: continuation.requestId,
            agentResponseId: continuation.responseId,
            userMessage: "Mom didn't answer. I've asked Google Agent to add ₹500.",
            now: new Date("2026-08-24T10:00:11.000Z"),
          },
        },
      );
      return {
        kind: "delegated",
        runId: "continuation-run-1",
        response: delegated.userMessage,
        orchestrationRequestId: delegated.requestId,
        taskId: delegated.taskId,
        steps: 1,
        observations: [],
      };
    }

    assert.equal(
      continuation.latestAgentResponse,
      "₹500 has been added to the expense sheet successfully.",
    );
    return {
      kind: "response",
      runId: "continuation-run-2",
      response: "Mom didn't answer, so I added ₹500 to the expense sheet.",
      steps: 1,
      observations: [],
    };
  }
}

function createDispatcher(
  repository: OrchestrationRepositoryPort,
  publisher: AgentTaskPublisher,
  ids: readonly string[],
  taskTimeoutMsByAgent: Readonly<Record<string, number>> = {},
): AgentTaskDispatcher {
  const registry = new AgentRegistry();
  registry.register({
    id: "device-agent",
    name: "Device Agent",
    description: "Handles connected-device actions.",
    capabilities: ["make phone calls"],
  });
  registry.register({
    id: "google-agent",
    name: "Google Agent",
    description: "Handles Google account operations.",
    capabilities: ["read and update Google Sheets"],
  });
  registry.register({
    id: "developer-agent",
    name: "Developer Agent",
    description: "Handles repository changes.",
    capabilities: ["inspect and modify repositories"],
  });
  const remainingIds = [...ids];
  return new AgentTaskDispatcher(registry, repository, publisher, {
    taskTimeoutMs: 30_000,
    taskTimeoutMsByAgent,
    createId: () => {
      const id = remainingIds.shift();
      assert.ok(id, "The test exhausted its deterministic ids.");
      return id;
    },
  });
}

function createResponseProcessor(
  repository: InMemoryOrchestrationRepository,
  orchestrator: AgentOrchestratorPort,
  updates: CoreUpdatePublisher,
  maxProcessingAttempts = 3,
): CoreAgentResponseProcessor {
  const transport: CoreAgentResponseProcessorOptions["transport"] = {
    async ensureResponseConsumerGroup() {},
    async readResponses() {
      return [];
    },
    async claimStaleResponses() {
      return [];
    },
    async acknowledgeResponse() {},
  };
  return new CoreAgentResponseProcessor({
    transport,
    repository,
    conversationRepository: {
      async getRecentMessages(conversationId, limit) {
        return repository.recentMessages(conversationId, limit);
      },
    },
    orchestrator,
    updates,
    userName: "Test User",
    timeZone: "Asia/Kolkata",
    workingMemoryMessageLimit: 20,
    reclaimIdleMs: 1_000,
    processingLeaseMs: 10_000,
    maxProcessingAttempts,
    now: () => {
      const lastResponse = [...repository.responses.values()].at(-1);
      return lastResponse?.agentTimestamp ?? NOW;
    },
  });
}

function initialOrchestration(
  overrides: Partial<
    NonNullable<DurableDelegationOptions["orchestration"]>
  > = {},
) {
  return {
    agentRunId: "initial-run",
    conversationId: "conversation-1",
    userId: "user-1",
    sourceMessageId: "source-message-1",
    originalUserRequest: ORIGINAL_REQUEST,
    executionContext: EXECUTION_CONTEXT,
    now: NOW,
    ...overrides,
  };
}

function plainResponse(
  taskId: string,
  message: string,
  timestamp: string,
): AgentResponse {
  return {
    taskId,
    agentId: "device-agent",
    message,
    timestamp,
  };
}

function taskRecord(
  overrides: Partial<AgentTaskRecord> &
    Pick<
      AgentTaskRecord,
      | "id"
      | "orchestrationRequestId"
      | "agentId"
      | "instruction"
      | "createdAt"
      | "deadlineAt"
    >,
): AgentTaskRecord {
  return {
    createdFromResponseId: null,
    publishedAt: null,
    redisMessageId: null,
    deliveryAttempts: 0,
    lastDeliveryError: null,
    abandonedAt: null,
    ...overrides,
  };
}

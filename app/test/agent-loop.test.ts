import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  AgentCancelledError,
  AgentLoop,
  AgentTimeoutError,
} from "../src/agent/agent-loop.js";
import { ShivaOrchestrator } from "../src/agent/orchestrator.js";
import {
  AgentPlannerError,
  ShivaAgentPlanner,
} from "../src/agent/planner.js";
import type {
  AgentDecision,
  AgentPlanner,
  AgentPlanningContext,
  AgentRequest,
} from "../src/agent/types.js";
import type { ChatInput } from "../src/brain/ai-provider.js";
import { AgentRegistry } from "../src/agents/agent-registry.js";
import {
  AgentTaskDispatcher,
  type AgentTaskPublisher,
} from "../src/agents/agent-task-dispatcher.js";
import type {
  AgentTaskRecord,
  CreateInitialRequestWithTaskInput,
  CreateNextTaskInput,
  OrchestrationRepositoryPort,
  OrchestrationRequestRecord,
} from "../src/agents/orchestration-repository.js";
import type { AgentTask } from "../src/agents/shared/protocol.js";
import type {
  ShivaSkill,
  SkillContext,
} from "../src/skills/types.js";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
} from "../src/security/confirmation.js";
import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { createDelegateToAgentSkill } from "../src/skills/delegate-to-agent/skill.js";
import { SkillRegistry } from "../src/skills/registry.js";

const request: AgentRequest = {
  userMessage: "Add INR 450 for pizza.",
  conversationId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  contextMessages: [{ role: "user", content: "Add INR 450 for pizza." }],
};

test("agent loop executes a skill, observes confirmed output, then responds", async () => {
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      executionCount += 1;
      return {
        success: true,
        data: { expenseId: "expense-1", amount: input.amount },
      };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "Added INR 450 for pizza.",
    },
  ];
  const planner: AgentPlanner = {
    async decide(context) {
      contexts.push(context);
      const decision = decisions.shift();
      if (!decision) throw new Error("No fake decision available.");
      return decision;
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
    () => "30000000-0000-4000-8000-000000000003",
  );

  const result = await loop.run(request);

  assert.equal(executionCount, 1);
  assert.equal(result.response, "Added INR 450 for pizza.");
  assert.equal(result.steps, 2);
  assert.equal(contexts[0]?.observations.length, 0);
  assert.deepEqual(contexts[1]?.observations[0]?.result, {
    success: true,
    data: { expenseId: "expense-1", amount: 450 },
  });
});

test("agent loop resumes only the exact action approved by a pending confirmation", async () => {
  const confirmationId = "40000000-0000-4000-8000-000000000004";
  const confirmationStore = new InMemoryConfirmationStore();
  const confirmations = new ConfirmationService(
    confirmationStore,
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "sensitive_fixture",
    description: "Executes one sensitive fixture action.",
    inputDescription: '{ "target": string, "force": boolean }',
    inputSchema: z
      .object({ target: z.string().min(1), force: z.boolean() })
      .strict(),
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "This fixture action is sensitive.",
    },
    async execute(input) {
      executionCount += 1;
      return { success: true, data: { completed: true, ...input } };
    },
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
  );
  const now = () => new Date("2026-08-20T00:00:00Z");
  const initialDecisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "sensitive_fixture",
      arguments: { target: "shiva", force: true },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "This exact action needs confirmation.",
    },
  ];
  const initialLoop = new AgentLoop(
    {
      async decide() {
        const decision = initialDecisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    now,
  );

  const pendingResult = await initialLoop.run({
    ...request,
    userMessage: "Execute the sensitive fixture action.",
  });
  const pendingObservation = pendingResult.observations[0];
  assert.ok(pendingObservation && !pendingObservation.result.success);
  if (!pendingObservation || pendingObservation.result.success) {
    assert.fail("Expected a pending confirmation observation.");
  }
  assert.equal(
    pendingObservation.result.error.confirmation?.id,
    confirmationId,
  );
  assert.equal(executionCount, 0);

  const approvalContexts: AgentPlanningContext[] = [];
  const approvalDecisions: AgentDecision[] = [
    {
      type: "approve_confirmation",
      confirmationId,
      skill: "sensitive_fixture",
      arguments: { force: true, target: "shiva" },
    },
    {
      type: "respond",
      message: "The exact sensitive action completed.",
    },
  ];
  const approvalLoop = new AgentLoop(
    {
      async decide(context) {
        approvalContexts.push(context);
        const decision = approvalDecisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    now,
  );

  const approvedResult = await approvalLoop.run({
    ...request,
    userMessage: "Yes, approve that exact action.",
  });

  assert.equal(approvalContexts[0]?.pendingConfirmation?.id, confirmationId);
  assert.equal(executionCount, 1);
  assert.equal(approvedResult.response, "The exact sensitive action completed.");
  assert.deepEqual(approvedResult.observations[0]?.result, {
    success: true,
    data: { completed: true, target: "shiva", force: true },
  });
  assert.equal(
    (await confirmationStore.findById(confirmationId))?.status,
    "EXECUTED",
  );
});

test("approved continuation delegation keeps its original Core context and returns queued work", async () => {
  const confirmationId = "41000000-0000-4000-8000-000000000004";
  const confirmations = new ConfirmationService(
    new InMemoryConfirmationStore(),
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  const executionContexts: SkillContext[] = [];
  registry.register({
    name: "sensitive_delegation_fixture",
    description: "Queues one sensitive delegated action.",
    inputDescription: '{ "instruction": string }',
    inputSchema: z.object({ instruction: z.string() }).strict(),
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "This fixture delegation is sensitive.",
    },
    async execute(_input, context) {
      executionContexts.push(context);
      return {
        success: true,
        data: {
          queued: true as const,
          requestId: "durable-request",
          taskId: "google-task",
          userMessage: "I've asked Google Agent to continue.",
        },
      };
    },
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
  );
  const now = () => new Date("2026-08-20T00:00:00Z");
  const continuationRequest: AgentRequest = {
    ...request,
    userMessage: "Call Mom and, if needed, add the expense.",
    delegationContinuation: {
      requestId: "durable-request",
      responseId: "device-response",
      originalUserRequest:
        "Call Mom and if she doesn't answer then add ₹500 in expense.",
      executionContext:
        "After Device Agent reports no answer, ask Google Agent to add ₹500.",
      latestAgentResponse: "Mom did not answer the call.",
    },
  };
  const pendingDecisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "sensitive_delegation_fixture",
      arguments: { instruction: "Add ₹500 to the expense sheet." },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "This continuation needs confirmation.",
    },
  ];
  const pendingLoop = new AgentLoop(
    {
      async decide() {
        const decision = pendingDecisions.shift();
        assert.ok(decision);
        return decision;
      },
    },
    executor,
    registry,
    8,
    now,
  );
  const pending = await pendingLoop.run(continuationRequest);
  assert.equal(pending.kind, "response");
  assert.equal(executionContexts.length, 0);

  const completionEvents: unknown[] = [];
  const approvalLoop = new AgentLoop(
    {
      async decide() {
        return {
          type: "approve_confirmation",
          confirmationId,
          skill: "sensitive_delegation_fixture",
          arguments: { instruction: "Add ₹500 to the expense sheet." },
        };
      },
    },
    executor,
    registry,
    8,
    now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (event) => {
      completionEvents.push(event);
    },
  );
  const approved = await approvalLoop.run({
    ...request,
    userMessage: "Yes, approve it.",
    sourceMessageId: "approval-message",
  });

  assert.equal(approved.kind, "delegated");
  if (approved.kind !== "delegated") assert.fail("Expected queued delegation.");
  assert.equal(approved.orchestrationRequestId, "durable-request");
  assert.equal(approved.taskId, "google-task");
  assert.equal(
    executionContexts[0]?.originalUserRequest,
    continuationRequest.delegationContinuation?.originalUserRequest,
  );
  assert.equal(executionContexts[0]?.orchestrationRequestId, "durable-request");
  assert.equal(executionContexts[0]?.agentResponseId, "device-response");
  assert.equal(executionContexts[0]?.sourceMessageId, "approval-message");
  assert.deepEqual(completionEvents, []);
});

test("real policy and dispatcher preserve initial approval identity and queue a continuation without confirming twice", async () => {
  const originalRequest =
    "Call Mom and if she doesn't answer then add ₹500 in expense.";
  const executionContext =
    "Call Mom through Device Agent. If she does not answer, ask Google Agent to add ₹500 to the expense sheet.";
  const sourceMessageId = "42000000-0000-4000-8000-000000000001";
  const durableRequestId = "42000000-0000-4000-8000-000000000002";
  const deviceTaskId = "42000000-0000-4000-8000-000000000003";
  const googleTaskId = "42000000-0000-4000-8000-000000000004";
  const deviceResponseId = "42000000-0000-4000-8000-000000000005";
  const confirmationId = "42000000-0000-4000-8000-000000000006";
  const now = () => new Date("2026-08-20T00:00:00Z");
  const initialInputs: CreateInitialRequestWithTaskInput[] = [];
  let nextInput: CreateNextTaskInput | undefined;
  let durableRequest: OrchestrationRequestRecord | undefined;
  const tasks = new Map<string, AgentTaskRecord>();
  const repository = {
    async createInitialRequestWithTask(input: CreateInitialRequestWithTaskInput) {
      initialInputs.push(input);
      durableRequest = orchestrationRequestFixture({
        id: input.requestId ?? durableRequestId,
        userId: input.userId,
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        originalUserRequest: input.originalUserRequest,
        executionContext: input.executionContext,
        createdAt: input.now,
        updatedAt: input.now,
      });
      const task = orchestrationTaskFixture({
        id: input.taskId ?? deviceTaskId,
        orchestrationRequestId: durableRequest.id,
        agentId: input.agentId,
        instruction: input.instruction,
        createdAt: input.now,
        deadlineAt: input.deadlineAt,
      });
      tasks.set(task.id, task);
      return { request: durableRequest, task };
    },
    async createNextTask(input: CreateNextTaskInput) {
      nextInput = input;
      const task = orchestrationTaskFixture({
        id: input.taskId ?? googleTaskId,
        orchestrationRequestId: input.requestId,
        agentId: input.agentId,
        instruction: input.instruction,
        createdFromResponseId: input.createdFromResponseId,
        createdAt: input.now,
        deadlineAt: input.deadlineAt,
      });
      tasks.set(task.id, task);
      return task;
    },
    async markTaskPublished(taskId: string, redisMessageId: string, publishedAt: Date) {
      const task = tasks.get(taskId);
      assert.ok(task);
      const published = {
        ...task,
        publishedAt,
        redisMessageId,
        deliveryAttempts: task.deliveryAttempts + 1,
      };
      tasks.set(task.id, published);
      return published;
    },
    async getRequest(requestId: string) {
      return durableRequest?.id === requestId ? durableRequest : undefined;
    },
  } as unknown as OrchestrationRepositoryPort;
  const published: AgentTask[] = [];
  const publisher: AgentTaskPublisher = {
    async publishTask(task) {
      published.push(task);
      return `${task.id}-stream`;
    },
    async isAgentOnline() {
      return true;
    },
  };
  const agents = new AgentRegistry();
  agents.register({
    id: "device-agent",
    name: "Device Agent",
    description: "Handles connected-device actions.",
    capabilities: ["make phone calls"],
  });
  agents.register({
    id: "google-agent",
    name: "Google Agent",
    description: "Handles Google account actions.",
    capabilities: ["update Google Sheets"],
  });
  const ids = [deviceTaskId, durableRequestId, googleTaskId];
  const dispatcher = new AgentTaskDispatcher(agents, repository, publisher, {
    taskTimeoutMs: 30_000,
    requireHeartbeat: false,
    createId: () => {
      const id = ids.shift();
      assert.ok(id);
      return id;
    },
  });
  const registry = new SkillRegistry();
  registry.register(createDelegateToAgentSkill(dispatcher, agents));
  const confirmationStore = new InMemoryConfirmationStore();
  const confirmations = new ConfirmationService(
    confirmationStore,
    300_000,
    () => confirmationId,
  );
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
  );
  const firstArguments = {
    agent: "device-agent",
    instruction: "Call Mom at +910000000000 and report whether she answered.",
    executionContext,
    userMessage: "I've asked Device Agent to call Mom.",
  };
  const initialDecisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "delegate_to_agent",
      arguments: firstArguments,
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "Please confirm this delegated action.",
    },
  ];
  const initialLoop = new AgentLoop(
    decisionQueue(initialDecisions),
    executor,
    registry,
    8,
    now,
  );
  const pending = await initialLoop.run({
    ...request,
    userMessage: originalRequest,
    sourceMessageId,
  });
  assert.equal(pending.kind, "response");
  assert.equal(initialInputs.length, 0);

  const approvalLoop = new AgentLoop(
    decisionQueue([
      {
        type: "approve_confirmation",
        confirmationId,
        skill: "delegate_to_agent",
        arguments: firstArguments,
      },
    ]),
    executor,
    registry,
    8,
    now,
  );
  const approved = await approvalLoop.run({
    ...request,
    userMessage: "Yes, approve that exact delegation.",
    sourceMessageId: "42000000-0000-4000-8000-000000000099",
  });
  assert.equal(approved.kind, "delegated");
  const [initialInput] = initialInputs;
  assert.ok(initialInput);
  assert.equal(initialInput.originalUserRequest, originalRequest);
  assert.equal(initialInput.sourceMessageId, sourceMessageId);
  assert.equal(initialInput.executionContext, executionContext);
  assert.equal((await confirmationStore.findById(confirmationId))?.status, "EXECUTED");

  const continuationLoop = new AgentLoop(
    decisionQueue([
      {
        type: "skill_call",
        skill: "delegate_to_agent",
        arguments: {
          agent: "google-agent",
          instruction: "Add ₹500 to the expense sheet and report the result.",
          userMessage: "Mom didn't answer. I've asked Google Agent to add ₹500.",
        },
        authorization: "user_authorized",
      },
    ]),
    executor,
    registry,
    8,
    now,
  );
  const continued = await continuationLoop.run({
    ...request,
    userMessage: originalRequest,
    delegationContinuation: {
      requestId: durableRequestId,
      responseId: deviceResponseId,
      originalUserRequest: originalRequest,
      executionContext,
      latestAgentResponse: "Mom did not answer the call.",
    },
  });

  assert.equal(continued.kind, "delegated");
  assert.equal(nextInput?.requestId, durableRequestId);
  assert.equal(nextInput?.createdFromResponseId, deviceResponseId);
  assert.equal(nextInput?.agentId, "google-agent");
  assert.equal(published.length, 2);
  assert.equal(await executor.getPendingConfirmation(request.userId, request.conversationId, now()), undefined);
});

test("agent loop denies a pending confirmation without executing its action", async () => {
  const confirmationId = "50000000-0000-4000-8000-000000000005";
  const confirmationStore = new InMemoryConfirmationStore();
  const confirmations = new ConfirmationService(
    confirmationStore,
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "sensitive_fixture",
    description: "Executes one sensitive fixture action.",
    inputDescription: '{ "target": string }',
    inputSchema: z.object({ target: z.string().min(1) }).strict(),
    execution: { mutability: "write", impact: "sensitive" },
    async execute() {
      executionCount += 1;
      return { success: true, data: { completed: true } };
    },
  });
  await confirmations.request({
    agentRunId: "30000000-0000-4000-8000-000000000003",
    userId: request.userId,
    conversationId: request.conversationId,
    skill: "sensitive_fixture",
    arguments: { target: "shiva" },
    reason: "This fixture action is sensitive.",
    executionMode: "FULL_ACCESS",
    mutability: "write",
    impact: "sensitive",
    settingsRevision: 0,
    now: new Date("2026-08-20T00:00:00Z"),
  });
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    confirmations,
  );
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    { type: "deny_confirmation", confirmationId },
    {
      type: "respond",
      message: "Cancelled the pending action.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    executor,
    registry,
    8,
    () => new Date("2026-08-20T00:00:00Z"),
  );

  const result = await loop.run({
    ...request,
    userMessage: "No, cancel that action.",
  });

  assert.equal(contexts[0]?.pendingConfirmation?.id, confirmationId);
  assert.equal(executionCount, 0);
  assert.equal(result.response, "Cancelled the pending action.");
  const denialObservation = result.observations[0];
  assert.ok(denialObservation && !denialObservation.result.success);
  if (!denialObservation || denialObservation.result.success) {
    assert.fail("Expected a denied confirmation observation.");
  }
  assert.equal(denialObservation.result.error.code, "CONFIRMATION_DENIED");
  assert.equal(
    (await confirmationStore.findById(confirmationId))?.status,
    "DENIED",
  );
});

test("confirmation lifecycle observes denials and passive expiry but not replayed executed approvals", async () => {
  const events: {
    readonly outcome: string;
    readonly requestId?: string;
    readonly responseId?: string;
  }[] = [];
  const store = new InMemoryConfirmationStore();
  const ids = [
    "51000000-0000-4000-8000-000000000001",
    "51000000-0000-4000-8000-000000000002",
    "51000000-0000-4000-8000-000000000003",
  ];
  const confirmations = new ConfirmationService(
    store,
    1_000,
    () => {
      const id = ids.shift();
      assert.ok(id);
      return id;
    },
    async ({ confirmation, outcome }) => {
      events.push({
        outcome,
        ...(confirmation.originContext.orchestrationRequestId
          ? {
              requestId:
                confirmation.originContext.orchestrationRequestId,
            }
          : {}),
        ...(confirmation.originContext.agentResponseId
          ? { responseId: confirmation.originContext.agentResponseId }
          : {}),
      });
    },
  );
  const requestedAt = new Date("2026-08-20T00:00:00Z");
  const common = {
    agentRunId: "51000000-0000-4000-8000-000000000010",
    userId: request.userId,
    conversationId: request.conversationId,
    skill: "delegate_to_agent",
    arguments: { agent: "google-agent", instruction: "Add ₹500." },
    reason: "Delegate the continuation?",
    executionMode: "FULL_ACCESS" as const,
    mutability: "write" as const,
    impact: "sensitive" as const,
    settingsRevision: 0,
    now: requestedAt,
  };

  const denied = await confirmations.request({
    ...common,
    originContext: {
      orchestrationRequestId: "request-denied",
      agentResponseId: "response-denied",
    },
  });
  await confirmations.resolve({
    id: denied.id,
    userId: request.userId,
    conversationId: request.conversationId,
    approved: false,
    now: requestedAt,
  });

  await confirmations.request({
    ...common,
    originContext: {
      orchestrationRequestId: "request-expired",
      agentResponseId: "response-expired",
    },
  });
  assert.equal(
    await confirmations.findPending(
      request.userId,
      request.conversationId,
      new Date(requestedAt.getTime() + 1_001),
    ),
    undefined,
  );

  const executed = await confirmations.request({
    ...common,
    now: new Date(requestedAt.getTime() + 2_000),
    originContext: {
      orchestrationRequestId: "request-with-child",
      agentResponseId: "response-with-child",
    },
  });
  await confirmations.resolve({
    id: executed.id,
    userId: request.userId,
    conversationId: request.conversationId,
    approved: true,
    skill: common.skill,
    arguments: common.arguments,
    now: new Date(requestedAt.getTime() + 2_000),
  });
  assert.ok(
    await confirmations.claim(
      executed.id,
      request.userId,
      0,
      new Date(requestedAt.getTime() + 2_000),
    ),
  );
  assert.ok(
    await confirmations.complete(
      executed.id,
      request.userId,
      new Date(requestedAt.getTime() + 2_000),
      true,
    ),
  );
  await confirmations.resolve({
    id: executed.id,
    userId: request.userId,
    conversationId: request.conversationId,
    approved: true,
    skill: common.skill,
    arguments: common.arguments,
    now: new Date(requestedAt.getTime() + 2_001),
  });

  assert.deepEqual(events, [
    {
      outcome: "denied",
      requestId: "request-denied",
      responseId: "response-denied",
    },
    {
      outcome: "expired",
      requestId: "request-expired",
      responseId: "response-expired",
    },
  ]);
});

test("an approved legacy continuation that fails without queuing closes its durable request", async () => {
  const confirmationId = "52000000-0000-4000-8000-000000000001";
  const confirmations = new ConfirmationService(
    new InMemoryConfirmationStore(),
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  registry.register({
    name: "legacy_continuation_fixture",
    description: "Represents an in-flight sensitive continuation.",
    inputDescription: '{ "target": string }',
    inputSchema: z.object({ target: z.string() }).strict(),
    execution: { mutability: "write", impact: "sensitive" },
    async execute() {
      return {
        success: false,
        error: { code: "DOWNSTREAM_UNAVAILABLE", message: "Unavailable." },
      };
    },
  });
  const requestedAt = new Date("2026-08-20T00:00:00Z");
  await confirmations.request({
    agentRunId: "52000000-0000-4000-8000-000000000002",
    userId: request.userId,
    conversationId: request.conversationId,
    skill: "legacy_continuation_fixture",
    arguments: { target: "google-agent" },
    originContext: {
      originalUserRequest: "Continue the compound delegated request.",
      orchestrationRequestId: "durable-request-failed",
      agentResponseId: "source-response-failed",
    },
    reason: "Confirm this legacy continuation.",
    executionMode: "FULL_ACCESS",
    mutability: "write",
    impact: "sensitive",
    settingsRevision: 0,
    now: requestedAt,
  });
  const completions: unknown[] = [];
  const loop = new AgentLoop(
    decisionQueue([
      {
        type: "approve_confirmation",
        confirmationId,
        skill: "legacy_continuation_fixture",
        arguments: { target: "google-agent" },
      },
      { type: "respond", message: "The continuation could not be completed." },
    ]),
    new SkillExecutor(
      registry,
      new ExecutionPolicyEngine(),
      undefined,
      undefined,
      undefined,
      undefined,
      confirmations,
    ),
    registry,
    8,
    () => requestedAt,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (event) => {
      completions.push(event);
    },
  );

  const result = await loop.run({
    ...request,
    userMessage: "Yes, approve it.",
  });

  assert.equal(result.kind, "response");
  assert.deepEqual(completions, [
    {
      requestId: "durable-request-failed",
      responseId: "source-response-failed",
      outcome: "approved",
      succeeded: false,
      now: requestedAt,
    },
  ]);
});

test("a successful approved non-delegation continuation completes after Core responds", async () => {
  const confirmationId = "53000000-0000-4000-8000-000000000001";
  const confirmationStore = new InMemoryConfirmationStore();
  const confirmations = new ConfirmationService(
    confirmationStore,
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  registry.register({
    name: "successful_continuation_fixture",
    description: "Completes one sensitive Core-owned continuation action.",
    inputDescription: '{ "value": string }',
    inputSchema: z.object({ value: z.string() }).strict(),
    execution: { mutability: "write", impact: "sensitive" },
    async execute(input) {
      return { success: true, data: { saved: input.value } };
    },
  });
  const requestedAt = new Date("2026-08-20T00:00:00Z");
  await confirmations.request({
    agentRunId: "53000000-0000-4000-8000-000000000002",
    userId: request.userId,
    conversationId: request.conversationId,
    skill: "successful_continuation_fixture",
    arguments: { value: "done" },
    originContext: {
      originalUserRequest: "Finish the compound delegated request.",
      orchestrationRequestId: "durable-request-succeeded",
      agentResponseId: "source-response-succeeded",
    },
    reason: "Confirm this legacy continuation.",
    executionMode: "FULL_ACCESS",
    mutability: "write",
    impact: "sensitive",
    settingsRevision: 0,
    now: requestedAt,
  });
  const completions: unknown[] = [];
  let plannerCall = 0;
  const planner: AgentPlanner = {
    async decide() {
      plannerCall += 1;
      if (plannerCall === 1) {
        return {
          type: "approve_confirmation",
          confirmationId,
          skill: "successful_continuation_fixture",
          arguments: { value: "done" },
        };
      }
      assert.equal(
        completions.length,
        0,
        "successful approval must wait for Core's terminal response",
      );
      return {
        type: "respond",
        message: "The continuation completed successfully.",
      };
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(
      registry,
      new ExecutionPolicyEngine(),
      undefined,
      undefined,
      undefined,
      undefined,
      confirmations,
    ),
    registry,
    8,
    () => requestedAt,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (event) => {
      completions.push(event);
    },
  );

  const result = await loop.run({
    ...request,
    userMessage: "Yes, approve it.",
  });

  assert.equal(result.kind, "response");
  assert.equal(result.response, "The continuation completed successfully.");
  assert.deepEqual(completions, [
    {
      requestId: "durable-request-succeeded",
      responseId: "source-response-succeeded",
      outcome: "approved",
      succeeded: true,
      now: requestedAt,
    },
  ]);
  assert.equal(
    (await confirmationStore.findById(confirmationId))?.status,
    "EXECUTED",
  );
});

test("agent loop executes an identical skill call only once per run", async () => {
  const registry = new SkillRegistry();
  let executionCount = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number, "description": string }',
    inputSchema: z
      .object({ amount: z.number().positive(), description: z.string() })
      .strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      executionCount += 1;
      return {
        success: true,
        data: { expenseId: `expense-${executionCount}`, ...input },
      };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { amount: 450, description: "Pizza" },
      authorization: "user_authorized",
    },
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { description: "Pizza", amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "Added INR 450 for pizza.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["record_expense"],
  });

  assert.equal(executionCount, 1);
  assert.equal(result.observations.length, 1);
});

test("agent loop does not re-execute an identical unavailable skill", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      executions += 1;
      return {
        success: false,
        error: {
          code: "WEB_RESEARCH_UNAVAILABLE",
          message: "Web research is unavailable.",
        },
      };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const failedCall: AgentDecision = {
    type: "skill_call",
    skill: "web_research",
    arguments: { query: "Ahmedabad weather" },
    authorization: "user_authorized",
  };
  const decisions: AgentDecision[] = [
    failedCall,
    failedCall,
    {
      type: "respond",
      message: "Web research is not configured.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run(request);
  assert.equal(executions, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.response, "Web research is not configured.");
  assert.match(contexts[2]?.plannerFeedback ?? "", /already failed/i);
});

test("agent loop preserves distinct record_expense calls in one run", async () => {
  const registry = new SkillRegistry();
  const executedAmounts: number[] = [];
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute(input) {
      executedAmounts.push(input.amount);
      return { success: true, data: { amount: input.amount } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { amount: 200 },
      authorization: "user_authorized",
    },
    { type: "respond", message: "Added both." },
  ];
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["record_expense"],
  });

  assert.deepEqual(executedAmounts, [450, 200]);
  assert.equal(result.observations.length, 2);
});

test("agent loop corrects a response that is missing required skill evidence", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      executions += 1;
      return { success: true, data: { expenseId: "expense-1" } };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "respond",
      message: "The expense was added.",
    },
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { amount: 450 },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "The expense was added.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run(request);
  assert.equal(executions, 1);
  assert.equal(result.response, "The expense was added.");
  assert.match(contexts[1]?.plannerFeedback ?? "", /no skill has been called/i);
});

test("agent loop accepts an early failure from a selected prerequisite skill", async () => {
  const registry = new SkillRegistry();
  let expenseExecutions = 0;
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return {
        success: false,
        error: { code: "SEARCH_UNAVAILABLE", message: "Search unavailable." },
      };
    },
  });
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      expenseExecutions += 1;
      return { success: true, data: { expenseId: "unexpected" } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "web_research",
      arguments: { query: "current price" },
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "I could not research the current price, so I did not record it.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["web_research", "record_expense"],
  });

  assert.equal(result.response, "I could not research the current price, so I did not record it.");
  assert.equal(expenseExecutions, 0);
  assert.equal(result.observations.length, 1);
});

test("agent loop feeds an out-of-scope call back to the planner for correction", async () => {
  const registry = new SkillRegistry();
  let expenseExecutions = 0;
  let webExecutions = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      expenseExecutions += 1;
      return { success: true, data: { expenseId: "unexpected" } };
    },
  });
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      webExecutions += 1;
      return { success: true, data: { answer: "grounded" } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "record_expense",
      arguments: { amount: 999 },
      authorization: "user_authorized",
    },
    {
      type: "skill_call",
      skill: "web_research",
      arguments: { query: "latest TTS models" },
      authorization: "user_authorized",
    },
    { type: "respond", message: "Research complete." },
  ];
  const contexts: AgentPlanningContext[] = [];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run({
    ...request,
    allowedSkills: ["web_research"],
  });
  assert.equal(expenseExecutions, 0);
  assert.equal(webExecutions, 1);
  assert.equal(result.response, "Research complete.");
  assert.match(contexts[1]?.plannerFeedback ?? "", /fixed to exactly these skills/i);
});

test("agent loop never executes or chat-falls-back from a repeated adversarial cross-skill call", async () => {
  const registry = new SkillRegistry();
  let expenseExecutions = 0;
  let webExecutions = 0;
  registry.register({
    name: "record_expense",
    description: "Records an expense.",
    inputDescription: '{ "amount": number }',
    inputSchema: z.object({ amount: z.number().positive() }).strict(),
    execution: { mutability: "write", impact: "normal" },
    async execute() {
      expenseExecutions += 1;
      return { success: true, data: { expenseId: "should-not-exist" } };
    },
  });
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute(input) {
      webExecutions += 1;
      return { success: true, data: { answer: input.query } };
    },
  });
  const invalidDecision: AgentDecision = {
    type: "skill_call",
    skill: "record_expense",
    arguments: { amount: 999 },
    authorization: "user_authorized",
  };
  const loop = new AgentLoop(
    {
      async decide() {
        return invalidDecision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    2,
  );

  const result = await loop.run({
    ...request,
    userMessage: "Research the latest TTS models.",
    allowedSkills: ["web_research"],
  });

  assert.equal(result.kind, "response");
  assert.equal(
    result.response,
    "I couldn't produce a valid tool plan for this request, so no action was executed.",
  );
  assert.equal(expenseExecutions, 0);
  assert.equal(webExecutions, 0);
});

test("agent loop corrects clarification attempted after tool execution", async () => {
  const registry = new SkillRegistry();
  registry.register({
    name: "web_research",
    description: "Researches the web.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string() }).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: { answer: "grounded" } };
    },
  });
  const contexts: AgentPlanningContext[] = [];
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "web_research",
      arguments: { query: "Ahmedabad weather" },
      authorization: "user_authorized",
    },
    { type: "clarify", message: "Which Ahmedabad?" },
    {
      type: "respond",
      message: "Here is the grounded forecast.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide(context) {
        contexts.push(context);
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  const result = await loop.run(request);
  assert.equal(result.response, "Here is the grounded forecast.");
  assert.match(contexts[2]?.plannerFeedback ?? "", /clarify was rejected/i);
  assert.equal(result.observations.length, 1);
});

test("agent loop retries an unknown skill scope then falls back to core chat", async () => {
  const registry = new SkillRegistry();
  let plannerCalls = 0;
  const planner: AgentPlanner = {
    async decide() {
      plannerCalls += 1;
      return {
        type: "skill_call",
        skill: "missing",
        arguments: {},
        authorization: "user_authorized",
      };
    },
  };
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    2,
  );

  const result = await loop.run(request);
  assert.equal(plannerCalls, 2);
  assert.equal(result.kind, "direct_chat");
  if (result.kind === "direct_chat") {
    assert.equal(result.plannerFallback, "INVALID_SCOPE");
  }
});

test("agent loop sanitizes cancellation and finalizes without another decision", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private disconnect reason"));
  let plannerCalls = 0;
  const registry = new SkillRegistry();
  const loop = new AgentLoop(
    {
      async decide() {
        plannerCalls += 1;
        return { type: "respond", message: "no" };
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
  );

  await assert.rejects(
    loop.run({ ...request, signal: controller.signal }),
    AgentCancelledError,
  );
  assert.equal(plannerCalls, 0);
});

test("agent loop aborts planner work at the request deadline", async () => {
  const registry = new SkillRegistry();
  let plannerObservedAbort = false;
  const loop = new AgentLoop(
    {
      async decide(context) {
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 100);
          const signal = context.request.signal;
          if (signal?.aborted) {
            plannerObservedAbort = true;
            clearTimeout(fallback);
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              plannerObservedAbort = true;
              clearTimeout(fallback);
              resolve();
            },
            { once: true },
          );
        });
        return { type: "respond", message: "Too late." };
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    8,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    10,
  );

  await assert.rejects(loop.run(request), AgentTimeoutError);
  assert.equal(plannerObservedAbort, true);
});

test("provider-neutral planner requests strict JSON and validates the decision", async () => {
  const inputs: ChatInput[] = [];
  const planner = new ShivaAgentPlanner({
    async chat(input) {
      inputs.push(input);
      return {
        content:
          '```json\n{"type":"skill_call","skill":"record_expense","arguments":{"amount":450},"authorization":"user_authorized"}\n```',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  const decision = await planner.decide({
    request,
    skills: [
      {
        name: "record_expense",
        description: "Records an expense.",
        inputDescription: '{ "amount": number }',
        configured: true,
        execution: { mutability: "write", impact: "normal" },
      },
    ],
    observations: [],
    step: 1,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(decision, {
    type: "skill_call",
    skill: "record_expense",
    arguments: { amount: 450 },
    authorization: "user_authorized",
  });
  assert.equal(typeof inputs[0]?.responseFormat, "object");
  assert.doesNotMatch(
    JSON.stringify(inputs[0]?.responseFormat),
    /\"outcome\"/,
  );
  assert.match(inputs[0]?.messages[0]?.content ?? "", /Never claim an action succeeded/);
  // Core registers no Google skills (see runtime.ts's includeGoogle: false),
  // so its default (role "core") prompt must not carry Google-only rules.
  assert.doesNotMatch(
    inputs[0]?.messages[0]?.content ?? "",
    /sheets_update/i,
  );
  assert.equal(inputs[0]?.temperature, 0);
});

test("role \"agent\" prompt carries only its injected domain rules and drops Core-only decision types", async () => {
  const inputs: ChatInput[] = [];
  const planner = new ShivaAgentPlanner(
    {
      async chat(input) {
        inputs.push(input);
        return { content: '{"type":"respond","message":"done"}' };
      },
      async *streamChat() {
        throw new Error("Planner decisions must use structured chat().");
      },
    },
    undefined,
    {
      role: "agent",
      domainRules: ["- Use sheets_update only after reading the sheet's live header."],
    },
  );

  await planner.decide({
    request,
    skills: [],
    observations: [
      {
        step: 1,
        skill: "sheets_read",
        arguments: {},
        result: { success: true, data: {} },
      },
    ],
    step: 2,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  const prompt = inputs[0]?.messages[0]?.content ?? "";
  assert.match(prompt, /Use sheets_update only after reading the sheet's live header/);
  assert.doesNotMatch(prompt, /direct_chat/);
  assert.doesNotMatch(prompt, /describe_capabilities/);
  assert.doesNotMatch(prompt, /approve_confirmation/);
  assert.doesNotMatch(prompt, /deny_confirmation/);
  assert.doesNotMatch(prompt, /delegate_to_agent/);
  assert.doesNotMatch(prompt, /workspace terminal/);
  assert.doesNotMatch(prompt, /clarify/);
});

test("the planner prompt gives a worked example for resolving a CONFIRMATION_REQUIRED observation", async () => {
  const inputs: ChatInput[] = [];
  const planner = new ShivaAgentPlanner({
    async chat(input) {
      inputs.push(input);
      return { content: '{"type":"direct_chat"}' };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  await planner.decide({
    request,
    skills: [],
    observations: [],
    step: 1,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  const prompt = inputs[0]?.messages[0]?.content ?? "";
  // A concrete worked example helps the smaller model stop at the normal
  // confirmation boundary instead of retrying the action.
  assert.match(prompt, /normal, expected stop, not a failed attempt to fix/);
  assert.match(
    prompt,
    /"respond","message":"Switch execution mode from Auto to Full Access\?/,
  );
  assert.match(prompt, /never substitute a human-readable label, different casing/);
});

test("planner skill calls fail closed when authorization is omitted", async () => {
  let attempts = 0;
  const planner = new ShivaAgentPlanner({
    async chat() {
      attempts += 1;
      return {
        content:
          '{"type":"skill_call","skill":"record_expense","arguments":{"amount":450}}',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  await assert.rejects(
    planner.decide({
      request,
      skills: [
        {
          name: "record_expense",
          description: "Records an expense.",
          inputDescription: '{ "amount": number }',
          configured: true,
          execution: { mutability: "write", impact: "normal" },
        },
      ],
      observations: [],
      step: 1,
      maxSteps: 8,
      now: new Date("2026-08-20T00:00:00Z"),
    }),
    AgentPlannerError,
  );
  assert.equal(attempts, 2);
});

test("the planner's onTrace logs the request, the raw response, thinking when present, and a parse rejection", async () => {
  const traces: Array<{ detail: Record<string, unknown>; message: string }> = [];
  let attempts = 0;
  const planner = new ShivaAgentPlanner(
    {
      async chat() {
        attempts += 1;
        return attempts === 1
          ? { content: "not valid json", thinking: "hmm, let me see" }
          : { content: '{"type":"direct_chat"}' };
      },
      async *streamChat() {
        throw new Error("Planner decisions must use structured chat().");
      },
    },
    (detail, message) => traces.push({ detail, message }),
  );

  const decision = await planner.decide({
    request,
    skills: [],
    observations: [],
    step: 1,
    maxSteps: 8,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(decision, { type: "direct_chat" });
  const messages = traces.map((entry) => entry.message);
  assert.deepEqual(messages, [
    "agent planner request",
    "agent planner response rejected",
    "agent planner request",
    "agent planner response",
  ]);
  assert.equal(traces[0]?.detail.step, 1);
  assert.ok(typeof traces[0]?.detail.systemPrompt === "string");
  assert.equal(traces[1]?.detail.rawResponse, "not valid json");
  assert.equal(traces[1]?.detail.rawThinking, "hmm, let me see");
  assert.deepEqual(traces[3]?.detail.decision, { type: "direct_chat" });
  // The second attempt's fake response carried no thinking field at all, so
  // the trace must omit rawThinking entirely rather than logging it empty.
  assert.equal("rawThinking" in (traces[3]?.detail ?? {}), false);
});

test("orchestrator sends every turn to semantic planner selection", async () => {
  const messages: string[] = [];
  const noOpLoop: Pick<AgentLoop, "run"> = {
    async run(input) {
      messages.push(input.userMessage);
      return {
        kind: "direct_chat",
        runId: "30000000-0000-4000-8000-000000000003",
        response: undefined,
        steps: 1,
        observations: [],
      };
    },
  };
  const orchestrator = new ShivaOrchestrator(noOpLoop);

  const inputs = [
    "Add ₹450 for pizza",
    "I spent ₹450 on pizza",
    "We just paid INR 900 for dinner",
    "What did I spend today?",
    "Research the latest TTS models",
    "What is the cost of an RTX 3090?",
    "What is Newton's third law?",
  ];
  for (const userMessage of inputs) {
    await orchestrator.run({ ...request, userMessage });
  }
  assert.deepEqual(messages, inputs);
});

test("orchestrator leaves semantic skill selection to the planner", async () => {
  let captured: AgentRequest | undefined;
  const orchestrator = new ShivaOrchestrator(
    {
      async run(scopedRequest) {
        captured = scopedRequest;
        return {
          kind: "response",
          runId: "30000000-0000-4000-8000-000000000003",
          response: "Completed.",
          steps: 1,
          observations: [],
        };
      },
    },
  );

  await orchestrator.run({
    ...request,
    userMessage:
      "Research current GPU pricing and record the cheapest as an expense.",
  });

  assert.equal(captured?.allowedSkills, undefined);
});

function fixtureSkill(
  name: string,
): ShivaSkill<Record<string, never>, Record<string, never>> {
  return {
    name,
    description: `${name} fixture skill.`,
    inputDescription: "{}",
    inputSchema: z.object({}).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      return { success: true, data: {} };
    },
  };
}

test("planner repairs a visible skill discriminator when the redundant skill field is omitted", async () => {
  let providerCalls = 0;
  const planner = new ShivaAgentPlanner({
    async chat() {
      providerCalls += 1;
      return {
        content:
          '{"type":"sheets_find","arguments":{"query":"Expense 2026"},"authorization":"user_authorized"}',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  const decision = await planner.decide({
    request: { ...request, userMessage: "Find Expense 2026." },
    skills: [
      {
        name: "sheets_find",
        description: "Finds a spreadsheet.",
        inputDescription: '{ "query": string }',
        configured: true,
        execution: { mutability: "read", impact: "normal" },
      },
    ],
    observations: [],
    step: 1,
    maxSteps: 12,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(decision, {
    type: "skill_call",
    skill: "sheets_find",
    arguments: { query: "Expense 2026" },
    authorization: "user_authorized",
  });
  assert.equal(providerCalls, 1);
});

test("planner repairs direct_chat plus message to a grounded response after tool evidence", async () => {
  let providerCalls = 0;
  const planner = new ShivaAgentPlanner({
    async chat() {
      providerCalls += 1;
      return {
        content:
          '{"type":"direct_chat","message":"Google Sheets rejected the guessed range, so no row was added."}',
      };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });

  const decision = await planner.decide({
    request: { ...request, userMessage: "Add the expense." },
    skills: [],
    observations: [
      {
        step: 2,
        skill: "sheets_read",
        arguments: { spreadsheetId: "sheet-1", range: "Sheet1!A1:E50" },
        result: {
          success: false,
          error: {
            code: "SHEETS_INVALID_INPUT",
            message: "The requested A1 range was invalid.",
          },
        },
      },
    ],
    step: 3,
    maxSteps: 12,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  assert.deepEqual(decision, {
    type: "respond",
    message: "Google Sheets rejected the guessed range, so no row was added.",
  });
  assert.equal(providerCalls, 1);
});

test("two invalid planner outputs after execution stop without consuming twelve steps", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    ...fixtureSkill("alpha_skill"),
    async execute() {
      executions += 1;
      return { success: true, data: { done: true } };
    },
  });
  const replies = [
    '{"type":"skill_call","skill":"alpha_skill","arguments":{},"authorization":"user_authorized"}',
    '{"type":"not_a_decision"}',
    '{"type":"not_a_decision"}',
  ];
  let providerCalls = 0;
  const planner = new ShivaAgentPlanner({
    async chat() {
      providerCalls += 1;
      const content = replies.shift();
      if (!content) throw new Error("No fake provider reply available.");
      return { content };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    12,
  );

  const result = await loop.run(request);

  assert.equal(executions, 1);
  assert.equal(providerCalls, 3);
  assert.equal(result.steps, 2);
  assert.match(result.response ?? "", /invalid structured output twice/i);
});

test("the captured sheets_find discriminator error repairs on its one retry", async () => {
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    name: "sheets_find",
    description: "Finds a Google Sheet.",
    inputDescription: '{ "query": string }',
    inputSchema: z.object({ query: z.string().min(1) }).strict(),
    execution: { mutability: "read", impact: "normal" },
    async execute() {
      executions += 1;
      return { success: true, data: { matches: [{ id: "sheet-1" }] } };
    },
  });
  const replies = [
    '{"type":"sheets_find","query":"Expense 2026"}',
    '{"type":"sheets_find","skill":"sheets_find","arguments":{"query":"Expense 2026"},"authorization":"user_authorized"}',
    '{"type":"respond","message":"I found the sheet."}',
  ];
  let providerCalls = 0;
  const loop = new AgentLoop(
    new ShivaAgentPlanner({
      async chat() {
        providerCalls += 1;
        const content = replies.shift();
        if (!content) throw new Error("No fake provider reply available.");
        return { content };
      },
      async *streamChat() {
        throw new Error("Planner decisions must use structured chat().");
      },
    }),
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    12,
  );

  const result = await loop.run({
    ...request,
    userMessage: "Find Expense 2026.",
  });

  assert.equal(providerCalls, 3);
  assert.equal(executions, 1);
  assert.equal(result.response, "I found the sheet.");
});

test("planner format failure preserves an exact pending confirmation question", async () => {
  const confirmationId = "40000000-0000-4000-8000-000000000099";
  const confirmations = new ConfirmationService(
    new InMemoryConfirmationStore(),
    300_000,
    () => confirmationId,
  );
  const registry = new SkillRegistry();
  let executions = 0;
  registry.register({
    ...fixtureSkill("sensitive_fixture"),
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "Switch to Full Access?",
    },
    async execute() {
      executions += 1;
      return { success: true, data: {} };
    },
  });
  const replies = [
    '{"type":"skill_call","skill":"sensitive_fixture","arguments":{},"authorization":"user_authorized"}',
    '{"type":"not_a_decision"}',
    '{"type":"not_a_decision"}',
  ];
  let providerCalls = 0;
  const planner = new ShivaAgentPlanner({
    async chat() {
      providerCalls += 1;
      const content = replies.shift();
      if (!content) throw new Error("No fake provider reply available.");
      return { content };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });
  const loop = new AgentLoop(
    planner,
    new SkillExecutor(
      registry,
      new ExecutionPolicyEngine(),
      undefined,
      undefined,
      undefined,
      undefined,
      confirmations,
    ),
    registry,
    12,
    () => new Date("2026-08-20T00:00:00Z"),
  );

  const result = await loop.run({
    ...request,
    userMessage: "Switch to full access.",
  });

  assert.equal(executions, 0);
  assert.equal(providerCalls, 3);
  assert.equal(result.steps, 2);
  assert.equal(
    result.response,
    "Switch to Full Access? Reply yes to approve this exact action or no to cancel.",
  );
});

test("a successful empty search can produce an honest no-match response", async () => {
  const registry = new SkillRegistry();
  registry.register({
    ...fixtureSkill("sheets_find"),
    async execute() {
      return { success: true, data: { matches: [] } };
    },
  });
  const decisions: AgentDecision[] = [
    {
      type: "skill_call",
      skill: "sheets_find",
      arguments: {},
      authorization: "user_authorized",
    },
    {
      type: "respond",
      message: "I couldn't find a spreadsheet matching that name.",
    },
  ];
  const loop = new AgentLoop(
    {
      async decide() {
        const decision = decisions.shift();
        if (!decision) throw new Error("No fake decision available.");
        return decision;
      },
    },
    new SkillExecutor(registry, new ExecutionPolicyEngine()),
    registry,
    12,
  );

  const result = await loop.run(request);

  assert.equal(
    result.response,
    "I couldn't find a spreadsheet matching that name.",
  );
  assert.deepEqual(result.observations[0]?.result, {
    success: true,
    data: { matches: [] },
  });
});

test("the current corrective task follows reference history in planner input", async () => {
  const inputs: ChatInput[] = [];
  const planner = new ShivaAgentPlanner({
    async chat(input) {
      inputs.push(input);
      return { content: '{"type":"direct_chat"}' };
    },
    async *streamChat() {
      throw new Error("Planner decisions must use structured chat().");
    },
  });
  await planner.decide({
    request: {
      ...request,
      userMessage: "Expense 2026 sorry",
      contextMessages: [
        { role: "user", content: "Find Expenses 2026" },
        { role: "assistant", content: "I couldn't find it." },
      ],
    },
    skills: [],
    observations: [],
    step: 1,
    maxSteps: 12,
    now: new Date("2026-08-20T00:00:00Z"),
  });

  const iteration = inputs[0]?.messages[1]?.content ?? "";
  const parsed = JSON.parse(iteration) as Record<string, unknown>;
  assert.equal(parsed.task, "Expense 2026 sorry");
  assert.match(String(parsed.taskRule), /supersedes conflicting names/i);
  assert.ok(iteration.indexOf("Expense 2026 sorry") > iteration.indexOf("Expenses 2026"));
});

function decisionQueue(decisions: AgentDecision[]): AgentPlanner {
  const remaining = [...decisions];
  return {
    async decide() {
      const decision = remaining.shift();
      if (!decision) throw new Error("No fake decision available.");
      return decision;
    },
  };
}

function orchestrationRequestFixture(
  overrides: Partial<OrchestrationRequestRecord> = {},
): OrchestrationRequestRecord {
  const fixtureNow = new Date("2026-08-20T00:00:00Z");
  return {
    id: "43000000-0000-4000-8000-000000000001",
    userId: request.userId,
    conversationId: request.conversationId,
    sourceMessageId: "43000000-0000-4000-8000-000000000002",
    originalUserRequest: request.userMessage,
    executionContext: "Delegate the requested work and reason over its reply.",
    createdAt: fixtureNow,
    updatedAt: fixtureNow,
    completedAt: null,
    ...overrides,
  };
}

function orchestrationTaskFixture(
  overrides: Partial<AgentTaskRecord> = {},
): AgentTaskRecord {
  const fixtureNow = new Date("2026-08-20T00:00:00Z");
  return {
    id: "43000000-0000-4000-8000-000000000003",
    orchestrationRequestId: "43000000-0000-4000-8000-000000000001",
    agentId: "device-agent",
    instruction: "Perform the narrow delegated task and report the outcome.",
    createdFromResponseId: null,
    createdAt: fixtureNow,
    deadlineAt: new Date("2026-08-20T00:05:00Z"),
    publishedAt: null,
    redisMessageId: null,
    deliveryAttempts: 0,
    lastDeliveryError: null,
    abandonedAt: null,
    ...overrides,
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableColumns } from "drizzle-orm";

import type { ShivaDatabase } from "../../src/database/pool.js";
import {
  agentResponses,
  agentTasks,
  orchestrationRequests,
} from "../../src/database/schema.js";
import {
  DrizzleOrchestrationRepository,
  OrchestrationRepositoryError,
  type AgentResponseRecord,
  type AgentTaskRecord,
  type OrchestrationRequestRecord,
} from "../../src/agents/orchestration-repository.js";

const NOW = new Date("2026-08-24T10:00:00.000Z");
const DEADLINE = new Date("2026-08-24T10:05:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_MESSAGE_ID = "00000000-0000-4000-8000-000000000003";
const REQUEST_ID = "00000000-0000-4000-8000-000000000004";
const TASK_ID = "00000000-0000-4000-8000-000000000005";
const RESPONSE_ID = "00000000-0000-4000-8000-000000000006";

test("orchestration persistence stores prose context and plain responses without semantic statuses", () => {
  assert.deepEqual(Object.keys(getTableColumns(orchestrationRequests)), [
    "id",
    "userId",
    "conversationId",
    "sourceMessageId",
    "originalUserRequest",
    "executionContext",
    "createdAt",
    "updatedAt",
    "completedAt",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(agentTasks)), [
    "id",
    "orchestrationRequestId",
    "agentId",
    "instruction",
    "createdFromResponseId",
    "createdAt",
    "deadlineAt",
    "publishedAt",
    "redisMessageId",
    "deliveryAttempts",
    "lastDeliveryError",
    "abandonedAt",
  ]);
  assert.deepEqual(Object.keys(getTableColumns(agentResponses)), [
    "id",
    "taskId",
    "agentId",
    "message",
    "metadata",
    "agentTimestamp",
    "receivedAt",
    "redisMessageId",
    "processingStartedAt",
    "processingAttempts",
    "lastProcessingError",
    "processedAt",
    "assistantMessageId",
  ]);
  assert.equal("status" in getTableColumns(orchestrationRequests), false);
  assert.equal("status" in getTableColumns(agentTasks), false);
  assert.equal("status" in getTableColumns(agentResponses), false);
});

test("initial request context and its first task are persisted atomically", async () => {
  const request = requestRecord();
  const task = taskRecord();
  const fake = scriptedDatabase({ insertResults: [[request], [task]] });
  const repository = new DrizzleOrchestrationRepository(fake.database);
  const result = await repository.createInitialRequestWithTask({
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    originalUserRequest:
      "Call Mom and if she doesn't answer then add ₹500 in expense.",
    executionContext:
      "Resolve Mom, ask Device Agent to call, then use Google Agent only if she does not answer.",
    agentId: "device-agent",
    instruction: "Call Mom at +910000000000. Report whether she answered.",
    now: NOW,
    deadlineAt: DEADLINE,
  });

  assert.deepEqual(result, { request, task });
  assert.equal(fake.transactionCount, 1);
  assert.equal(fake.insertedValues.length, 2);
  assert.equal(
    (fake.insertedValues[0] as { executionContext: unknown }).executionContext,
    request.executionContext,
  );
  assert.deepEqual(fake.insertedValues[1], {
    id: TASK_ID,
    orchestrationRequestId: REQUEST_ID,
    agentId: "device-agent",
    instruction: "Call Mom at +910000000000. Report whether she answered.",
    createdAt: NOW,
    deadlineAt: DEADLINE,
  });
});

test("an outbox restart can reload the request that owns a task", async () => {
  const request = requestRecord();
  const fake = scriptedDatabase({ selectResults: [[request]] });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  assert.deepEqual(await repository.getRequest(REQUEST_ID), request);
});

test("a plain agent message is correlated to the exact task and request", async () => {
  const request = requestRecord();
  const task = taskRecord();
  const response = responseRecord();
  const fake = scriptedDatabase({
    selectResults: [[{ request, task }], []],
    insertResults: [[response]],
  });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  const accepted = await repository.acceptResponse(
    {
      taskId: TASK_ID,
      agentId: "device-agent",
      message: "Mom did not answer the call.",
      metadata: { callId: "call-789" },
      timestamp: "2026-08-24T10:00:10.000Z",
    },
    "1787559400000-0",
  );

  assert.deepEqual(accepted, { accepted: true, request, task, response });
  assert.deepEqual(fake.insertedValues[0], {
    taskId: TASK_ID,
    agentId: "device-agent",
    message: "Mom did not answer the call.",
    metadata: { callId: "call-789" },
    agentTimestamp: new Date("2026-08-24T10:00:10.000Z"),
    redisMessageId: "1787559400000-0",
  });
  assert.equal("status" in (fake.insertedValues[0] as object), false);
});

test("a response-stream replay remains idempotent after its request completed", async () => {
  const request = requestRecord({ completedAt: DEADLINE });
  const task = taskRecord();
  const response = responseRecord({
    processingStartedAt: NOW,
    processedAt: DEADLINE,
    assistantMessageId: "00000000-0000-4000-8000-000000000008",
  });
  const fake = scriptedDatabase({
    selectResults: [[{ request, task }], [response]],
  });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  const replay = await repository.acceptResponse(
    {
      taskId: TASK_ID,
      agentId: "device-agent",
      message: "Mom did not answer the call.",
      timestamp: "2026-08-24T10:00:10.000Z",
    },
    "1787559400001-0",
  );

  assert.deepEqual(replay, { accepted: false, request, task, response });
  assert.deepEqual(fake.insertedValues, []);
});

test("continuation task creation is idempotent by its source response", async () => {
  const existing = taskRecord({
    id: "00000000-0000-4000-8000-000000000007",
    agentId: "google-agent",
    instruction: "Add ₹500 to the expense sheet.",
    createdFromResponseId: RESPONSE_ID,
  });
  const fake = scriptedDatabase({
    selectResults: [
      [{ requestId: REQUEST_ID, completedAt: null }],
      [existing],
    ],
    insertResults: [[]],
  });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  const task = await repository.createNextTask({
    requestId: REQUEST_ID,
    createdFromResponseId: RESPONSE_ID,
    agentId: "google-agent",
    instruction: "Add ₹500 to the expense sheet.",
    now: NOW,
    deadlineAt: DEADLINE,
  });

  assert.deepEqual(task, existing);
  // A retry for a response that already produced a task must be recognized
  // as idempotent before any insert is attempted, and before the per-agent
  // delegation cap is checked — otherwise a legitimate crash-recovery retry
  // could be wrongly refused once the cap is reached.
  assert.deepEqual(fake.insertedValues, []);
});

test("a terminal continuation confirmation completes only when no child task exists", async () => {
  const request = requestRecord();
  const response = responseRecord({ processedAt: NOW });
  const completed = requestRecord({ completedAt: DEADLINE, updatedAt: DEADLINE });
  const fake = scriptedDatabase({
    selectResults: [[{ request, response }], []],
    updateResults: [[completed]],
  });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  assert.deepEqual(
    await repository.completeRequestAfterConfirmation({
      requestId: REQUEST_ID,
      responseId: RESPONSE_ID,
      now: DEADLINE,
    }),
    completed,
  );
  assert.ok(
    fake.updateValues.some(
      (value) =>
        (value as { completedAt?: Date }).completedAt?.getTime() ===
        DEADLINE.getTime(),
    ),
  );
});

test("a replayed confirmation cannot complete a request after its child task was queued", async () => {
  const request = requestRecord();
  const response = responseRecord({ processedAt: NOW });
  const fake = scriptedDatabase({
    selectResults: [
      [{ request, response }],
      [{ id: "00000000-0000-4000-8000-000000000009" }],
    ],
  });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  assert.equal(
    await repository.completeRequestAfterConfirmation({
      requestId: REQUEST_ID,
      responseId: RESPONSE_ID,
      now: DEADLINE,
    }),
    undefined,
  );
  assert.deepEqual(fake.updateValues, []);
});

test("finishing a response atomically persists Core's assistant message and completion time", async () => {
  const request = requestRecord();
  const task = taskRecord();
  const claimed = responseRecord({ processingStartedAt: NOW });
  const assistantMessage = {
    id: "00000000-0000-4000-8000-000000000008",
    conversationId: CONVERSATION_ID,
    role: "assistant" as const,
    content: "Mom didn't answer, so I added ₹500 to the expense sheet.",
    createdAt: NOW,
  };
  const fake = scriptedDatabase({
    selectResults: [[claimed], [task], [request]],
    insertResults: [[assistantMessage]],
    updateResults: [[{ id: RESPONSE_ID }]],
  });
  const repository = new DrizzleOrchestrationRepository(fake.database);

  const stored = await repository.finishResponseWithMessage({
    requestId: REQUEST_ID,
    responseId: RESPONSE_ID,
    message: assistantMessage.content,
    complete: true,
    claimedAt: NOW,
    now: NOW,
  });

  assert.deepEqual(stored, assistantMessage);
  assert.deepEqual(fake.insertedValues[0], {
    conversationId: CONVERSATION_ID,
    role: "assistant",
    content: assistantMessage.content,
    createdAt: NOW,
  });
  assert.ok(
    fake.updateValues.some(
      (value) =>
        (value as { completedAt?: Date }).completedAt?.getTime() ===
        NOW.getTime(),
    ),
  );
  assert.ok(
    fake.updateValues.some(
      (value) =>
        (value as { assistantMessageId?: string }).assistantMessageId ===
        assistantMessage.id,
    ),
  );
});

test("invalid natural-language context and response timestamps fail before database access", async () => {
  const fake = scriptedDatabase({});
  const repository = new DrizzleOrchestrationRepository(fake.database);

  await assert.rejects(
    repository.createInitialRequestWithTask({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      sourceMessageId: SOURCE_MESSAGE_ID,
      originalUserRequest: "Call Mom.",
      executionContext: "   ",
      agentId: "device-agent",
      instruction: "Call Mom.",
      now: NOW,
      deadlineAt: DEADLINE,
    }),
    (error: unknown) =>
      error instanceof OrchestrationRepositoryError &&
      error.failure === "INVALID_INPUT",
  );
  await assert.rejects(
    repository.acceptResponse(
      {
        taskId: TASK_ID,
        agentId: "device-agent",
        message: "Done.",
        timestamp: "not-a-timestamp",
      },
      "1787559400000-0",
    ),
    (error: unknown) =>
      error instanceof OrchestrationRepositoryError &&
      error.failure === "INVALID_INPUT",
  );
  assert.equal(fake.transactionCount, 0);
});

function requestRecord(
  overrides: Partial<OrchestrationRequestRecord> = {},
): OrchestrationRequestRecord {
  return {
    id: REQUEST_ID,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    originalUserRequest:
      "Call Mom and if she doesn't answer then add ₹500 in expense.",
    executionContext:
      "Resolve Mom, ask Device Agent to call, then use Google Agent only if she does not answer.",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function taskRecord(
  overrides: Partial<AgentTaskRecord> = {},
): AgentTaskRecord {
  return {
    id: TASK_ID,
    orchestrationRequestId: REQUEST_ID,
    agentId: "device-agent",
    instruction: "Call Mom at +910000000000. Report whether she answered.",
    createdFromResponseId: null,
    createdAt: NOW,
    deadlineAt: DEADLINE,
    publishedAt: null,
    redisMessageId: null,
    deliveryAttempts: 0,
    lastDeliveryError: null,
    abandonedAt: null,
    ...overrides,
  };
}

function responseRecord(
  overrides: Partial<AgentResponseRecord> = {},
): AgentResponseRecord {
  return {
    id: RESPONSE_ID,
    taskId: TASK_ID,
    agentId: "device-agent",
    message: "Mom did not answer the call.",
    metadata: { callId: "call-789" },
    agentTimestamp: new Date("2026-08-24T10:00:10.000Z"),
    receivedAt: new Date("2026-08-24T10:00:11.000Z"),
    redisMessageId: "1787559400000-0",
    processingStartedAt: null,
    processingAttempts: 0,
    lastProcessingError: null,
    processedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

interface ScriptedDatabaseInput {
  readonly selectResults?: readonly (readonly unknown[])[];
  readonly insertResults?: readonly (readonly unknown[])[];
  readonly updateResults?: readonly (readonly unknown[])[];
}

function scriptedDatabase(input: ScriptedDatabaseInput): {
  readonly database: ShivaDatabase;
  readonly insertedValues: unknown[];
  readonly updateValues: unknown[];
  readonly transactionCount: number;
} {
  const selectResults = [...(input.selectResults ?? [])];
  const insertResults = [...(input.insertResults ?? [])];
  const updateResults = [...(input.updateResults ?? [])];
  const insertedValues: unknown[] = [];
  const updateValues: unknown[] = [];
  const state = { transactionCount: 0 };

  const database = {
    execute: async () => [],
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => {
      state.transactionCount += 1;
      return run(database);
    },
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => selectResults.shift() ?? [],
      };
      return chain;
    },
    insert: () => ({
      values: (values: unknown) => {
        insertedValues.push(values);
        const chain = {
          onConflictDoNothing: () => chain,
          returning: async () => insertResults.shift() ?? [],
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: unknown) => {
        updateValues.push(values);
        const chain = {
          where: () => chain,
          returning: async () => updateResults.shift() ?? [],
        };
        return chain;
      },
    }),
  } as unknown as ShivaDatabase;

  return {
    database,
    insertedValues,
    updateValues,
    get transactionCount() {
      return state.transactionCount;
    },
  };
}

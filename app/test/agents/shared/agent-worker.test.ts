import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentWorker,
  AgentWorkerTransportError,
  type AgentWorkerTransport,
} from "../../../src/agents/shared/agent-worker.js";
import type { AgentTaskDelivery } from "../../../src/agents/shared/redis-agent-transport.js";
import type {
  AgentResponse,
  AgentTask,
} from "../../../src/agents/shared/protocol.js";

const task: AgentTask = {
  id: "task-123",
  conversationId: "conversation-456",
  agentId: "device-agent",
  instruction: "Call Mom at +91XXXXXXXXXX. Report whether the call was answered.",
  createdAt: "2026-08-24T10:00:00.000Z",
};

function delivery(
  attempt: number,
  recovered = attempt > 1,
): AgentTaskDelivery {
  return {
    streamId: "1-0",
    task,
    attempt,
    recovered,
  };
}

class FakeWorkerTransport implements AgentWorkerTransport {
  readonly order: string[] = [];
  readonly groups: string[] = [];
  readonly claims: (readonly AgentTaskDelivery[])[] = [];
  readonly reads: (readonly AgentTaskDelivery[])[] = [];
  readonly responses: AgentResponse[] = [];
  readonly publishedTaskIds = new Set<string>();
  readonly acknowledgements: { agentId: string; streamId: string }[] = [];
  readonly leaseRenewals: {
    agentId: string;
    consumer: string;
    streamId: string;
  }[] = [];
  readonly heartbeats: { agentId: string; consumer: string; ttlMs: number }[] = [];
  readonly clearedHeartbeats: { agentId: string; consumer: string }[] = [];
  publishError?: Error;
  onPublish?: () => void;
  onAcknowledge?: () => void;
  readDelayMs = 0;
  renewLeaseResult = true;

  async ensureTaskConsumerGroup(agentId: string): Promise<void> {
    this.groups.push(agentId);
  }

  async claimStaleTasks(): Promise<readonly AgentTaskDelivery[]> {
    return this.claims.shift() ?? [];
  }

  async readTasks(): Promise<readonly AgentTaskDelivery[]> {
    if (this.readDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.readDelayMs));
    }
    return this.reads.shift() ?? [];
  }

  async publishResponse(response: AgentResponse): Promise<string> {
    this.order.push("publish");
    if (this.publishError) throw this.publishError;
    this.responses.push(response);
    this.publishedTaskIds.add(response.taskId);
    this.onPublish?.();
    return "2-0";
  }

  async hasPublishedResponse(taskId: string): Promise<boolean> {
    return this.publishedTaskIds.has(taskId);
  }

  async acknowledgeTask(agentId: string, streamId: string): Promise<void> {
    this.order.push("ack");
    this.acknowledgements.push({ agentId, streamId });
    this.onAcknowledge?.();
  }

  async renewTaskLease(
    agentId: string,
    consumer: string,
    streamId: string,
  ): Promise<boolean> {
    this.leaseRenewals.push({ agentId, consumer, streamId });
    return this.renewLeaseResult;
  }

  async refreshAgentHeartbeat(
    agentId: string,
    consumer: string,
    ttlMs: number,
  ): Promise<void> {
    this.heartbeats.push({ agentId, consumer, ttlMs });
  }

  async clearAgentHeartbeat(agentId: string, consumer: string): Promise<void> {
    this.clearedHeartbeats.push({ agentId, consumer });
  }
}

function workerOptions(
  transport: FakeWorkerTransport,
  handler: ConstructorParameters<typeof AgentWorker>[0]["handler"],
) {
  return {
    agentId: "device-agent",
    consumerName: "device-test-worker",
    transport,
    handler,
    reclaimIdleMs: 0,
    readBlockMs: 1,
    heartbeatIntervalMs: 1_000,
    heartbeatTtlMs: 2_000,
    transportRetryDelayMs: 1,
    now: () => new Date("2026-08-24T10:01:00.000Z"),
  } as const;
}

test("worker publishes a plain-text response before acknowledging its task", async () => {
  const transport = new FakeWorkerTransport();
  const controller = new AbortController();
  transport.claims.push([]);
  transport.reads.push([delivery(1, false)]);
  transport.onPublish = () => controller.abort();
  const worker = new AgentWorker(
    workerOptions(transport, async () => "Mom did not answer the call."),
  );

  await worker.start(controller.signal);

  assert.deepEqual(transport.order, ["publish", "ack"]);
  assert.deepEqual(transport.responses, [
    {
      taskId: task.id,
      agentId: "device-agent",
      message: "Mom did not answer the call.",
      timestamp: "2026-08-24T10:01:00.000Z",
    },
  ]);
  assert.deepEqual(transport.acknowledgements, [
    { agentId: "device-agent", streamId: "1-0" },
  ]);
  assert.equal("status" in (transport.responses[0] ?? {}), false);
  assert.deepEqual(transport.groups, ["device-agent"]);
  assert.equal(transport.heartbeats.length, 1);
  assert.deepEqual(transport.clearedHeartbeats, [
    { agentId: "device-agent", consumer: "device-test-worker" },
  ]);
});

test("restart recovery acknowledges an already-published response without rerunning the handler", async () => {
  const transport = new FakeWorkerTransport();
  const controller = new AbortController();
  let handlerCalls = 0;
  transport.publishedTaskIds.add(task.id);
  transport.claims.push([delivery(2, true)]);
  transport.onAcknowledge = () => controller.abort();
  const worker = new AgentWorker(
    workerOptions(transport, async () => {
      handlerCalls += 1;
      return "This handler must not run.";
    }),
  );

  await worker.start(controller.signal);

  assert.equal(handlerCalls, 0);
  assert.deepEqual(transport.responses, []);
  assert.deepEqual(transport.acknowledgements, [
    { agentId: "device-agent", streamId: "1-0" },
  ]);
});

test("a slow handler renews its pending task lease until response publication", async () => {
  const transport = new FakeWorkerTransport();
  const controller = new AbortController();
  transport.claims.push([]);
  transport.reads.push([delivery(1, false)]);
  transport.onPublish = () => controller.abort();
  const worker = new AgentWorker({
    ...workerOptions(transport, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return "Mom did not answer the call.";
    }),
    reclaimIdleMs: 15,
    taskLeaseRenewIntervalMs: 3,
  });

  await worker.start(controller.signal);

  assert.ok(
    transport.leaseRenewals.length >= 2,
    `expected repeated lease renewal, got ${transport.leaseRenewals.length}`,
  );
  assert.ok(
    transport.leaseRenewals.every(
      (renewal) =>
        renewal.agentId === "device-agent" &&
        renewal.consumer === "device-test-worker" &&
        renewal.streamId === "1-0",
    ),
  );
  assert.deepEqual(transport.order, ["publish", "ack"]);
});

test("a lost task lease aborts the handler result without publishing or acknowledging", async () => {
  const transport = new FakeWorkerTransport();
  const controller = new AbortController();
  transport.claims.push([]);
  transport.reads.push([delivery(1, false)]);
  transport.renewLeaseResult = false;
  const worker = new AgentWorker({
    ...workerOptions(transport, async (_task, context) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      assert.equal(context.signal.aborted, true);
      controller.abort();
      return "A stale result that must not be published.";
    }),
    reclaimIdleMs: 15,
    taskLeaseRenewIntervalMs: 2,
  });

  await worker.start(controller.signal);

  assert.ok(transport.leaseRenewals.length >= 1);
  assert.deepEqual(transport.responses, []);
  assert.deepEqual(transport.acknowledgements, []);
});

test("failed work remains pending and is recovered with XAUTOCLAIM-style redelivery", async () => {
  const transport = new FakeWorkerTransport();
  const controller = new AbortController();
  const attempts: number[] = [];
  const retries: number[] = [];
  transport.claims.push([], [delivery(2, true)]);
  transport.reads.push([delivery(1, false)]);
  transport.onPublish = () => controller.abort();
  const worker = new AgentWorker({
    ...workerOptions(transport, async (_task, context) => {
      attempts.push(context.attempt);
      if (context.attempt === 1) throw new Error("phone process restarted");
      return "Mom did not answer the call.";
    }),
    onRetry: ({ attempt }) => retries.push(attempt),
  });

  await worker.start(controller.signal);

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(retries, [1]);
  assert.deepEqual(transport.order, ["publish", "ack"]);
  assert.deepEqual(transport.acknowledgements, [
    { agentId: "device-agent", streamId: "1-0" },
  ]);
});

test("bounded handler retries end in a natural-language technical failure response", async () => {
  const transport = new FakeWorkerTransport();
  const controller = new AbortController();
  transport.claims.push([], [delivery(2, true)]);
  transport.reads.push([delivery(1, false)]);
  transport.onPublish = () => controller.abort();
  const worker = new AgentWorker({
    ...workerOptions(transport, async () => {
      throw new Error("device bridge unavailable");
    }),
    maxAttempts: 2,
  });

  await worker.start(controller.signal);

  assert.deepEqual(transport.order, ["publish", "ack"]);
  assert.deepEqual(transport.responses, [
    {
      taskId: task.id,
      agentId: "device-agent",
      message: "device-agent could not complete the delegated task after 2 attempts.",
      metadata: { transportFailure: true, attempts: 2 },
      timestamp: "2026-08-24T10:01:00.000Z",
    },
  ]);
});

test("an aborted worker leaves its unacknowledged task for a restarted consumer", async () => {
  const transport = new FakeWorkerTransport();
  const firstController = new AbortController();
  transport.claims.push([]);
  transport.reads.push([delivery(1, false)]);
  const firstWorker = new AgentWorker(
    workerOptions(transport, async () => {
      firstController.abort();
      throw new Error("process terminated");
    }),
  );

  await firstWorker.start(firstController.signal);
  assert.deepEqual(transport.acknowledgements, []);

  const secondController = new AbortController();
  transport.claims.push([delivery(2, true)]);
  transport.onPublish = () => secondController.abort();
  const secondWorker = new AgentWorker(
    workerOptions(transport, async (_task, context) => {
      assert.equal(context.recovered, true);
      return "Recovered the call task after restart.";
    }),
  );

  await secondWorker.start(secondController.signal);
  assert.deepEqual(transport.acknowledgements, [
    { agentId: "device-agent", streamId: "1-0" },
  ]);
});

test("a response publish failure never acknowledges the task and transport retries are bounded", async () => {
  const transport = new FakeWorkerTransport();
  transport.claims.push([]);
  transport.reads.push([delivery(1, false)]);
  transport.publishError = new Error("redis write failed");
  const worker = new AgentWorker({
    ...workerOptions(transport, async () => "The call completed."),
    maxConsecutiveTransportErrors: 1,
  });

  await assert.rejects(
    () => worker.start(),
    (error: unknown) => error instanceof AgentWorkerTransportError,
  );
  assert.deepEqual(transport.order, ["publish"]);
  assert.deepEqual(transport.acknowledgements, []);
});

test("stop aborts polling cleanly and removes only this worker's heartbeat", async () => {
  const transport = new FakeWorkerTransport();
  transport.claims.push([]);
  transport.readDelayMs = 10;
  const worker = new AgentWorker(
    workerOptions(transport, async () => "unused"),
  );

  const running = worker.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  await worker.stop();
  await running;

  assert.deepEqual(transport.clearedHeartbeats, [
    { agentId: "device-agent", consumer: "device-test-worker" },
  ]);
});

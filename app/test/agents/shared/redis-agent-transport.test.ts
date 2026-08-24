import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RedisAgentTransport,
  type RawStreamEntry,
  type RedisAgentTransportBackend,
} from "../../../src/agents/shared/redis-agent-transport.js";
import {
  AGENT_RESPONSE_STREAM,
  AGENT_TASK_STREAM,
  CORE_RESPONSE_CONSUMER_GROUP,
  agentResponsePublicationKey,
  agentTaskPublicationKey,
  encodeAgentResponse,
  encodeAgentTask,
  type AgentResponse,
  type AgentTask,
} from "../../../src/agents/shared/protocol.js";

const deviceTask: AgentTask = {
  id: "task-device",
  conversationId: "conversation-one",
  agentId: "device-agent",
  instruction: "Call Mom and report what happened.",
  createdAt: "2026-08-24T10:00:00.000Z",
};

class FakeRedisBackend implements RedisAgentTransportBackend {
  connected = false;
  closed = false;
  readonly additions: {
    stream: string;
    publicationKey: string;
    fields: Readonly<Record<string, string>>;
  }[] = [];
  readonly publications = new Map<string, string>();
  readonly groups: { stream: string; group: string }[] = [];
  readonly reads: {
    stream: string;
    group: string;
    consumer: string;
    blockMs: number;
    count: number;
  }[] = [];
  readonly claims: {
    stream: string;
    group: string;
    consumer: string;
    minIdleMs: number;
    count: number;
  }[] = [];
  readonly acknowledgements: { stream: string; group: string; entryId: string }[] = [];
  readonly leaseRenewals: {
    stream: string;
    group: string;
    consumer: string;
    entryId: string;
  }[] = [];
  readonly readQueue: (readonly RawStreamEntry[])[] = [];
  readonly claimQueue: (readonly RawStreamEntry[])[] = [];
  readonly deliveryCounts = new Map<string, number>();
  readonly heartbeats = new Map<string, { consumer: string; ttlMs: number }>();

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async addOnce(
    stream: string,
    publicationKey: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<string> {
    const existing = this.publications.get(publicationKey);
    if (existing) return existing;
    this.additions.push({ stream, publicationKey, fields });
    const streamId = `${this.additions.length}-0`;
    this.publications.set(publicationKey, streamId);
    return streamId;
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    this.groups.push({ stream, group });
  }

  async readGroup(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly blockMs: number;
    readonly count: number;
  }): Promise<readonly RawStreamEntry[]> {
    this.reads.push(input);
    return this.readQueue.shift() ?? [];
  }

  async autoClaim(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly minIdleMs: number;
    readonly count: number;
  }): Promise<readonly RawStreamEntry[]> {
    this.claims.push(input);
    return this.claimQueue.shift() ?? [];
  }

  async deliveryCount(
    stream: string,
    group: string,
    entryId: string,
  ): Promise<number> {
    return this.deliveryCounts.get(`${stream}|${group}|${entryId}`) ?? 1;
  }

  async acknowledge(
    stream: string,
    group: string,
    entryId: string,
  ): Promise<void> {
    this.acknowledgements.push({ stream, group, entryId });
  }

  async renewPendingEntry(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly entryId: string;
  }): Promise<boolean> {
    this.leaseRenewals.push(input);
    return true;
  }

  async getPublication(publicationKey: string): Promise<string | null> {
    return this.publications.get(publicationKey) ?? null;
  }

  async setHeartbeat(key: string, consumer: string, ttlMs: number): Promise<void> {
    this.heartbeats.set(key, { consumer, ttlMs });
  }

  async getHeartbeat(key: string): Promise<string | null> {
    return this.heartbeats.get(key)?.consumer ?? null;
  }

  async removeHeartbeat(key: string, consumer: string): Promise<void> {
    if (this.heartbeats.get(key)?.consumer === consumer) this.heartbeats.delete(key);
  }
}

test("transport publishes minimal task and response envelopes to the two shared streams", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });
  const response: AgentResponse = {
    taskId: deviceTask.id,
    agentId: deviceTask.agentId,
    message: "Mom did not answer the call.",
    timestamp: "2026-08-24T10:01:00.000Z",
  };

  await transport.connect();
  assert.equal(await transport.publishTask(deviceTask), "1-0");
  assert.equal(await transport.publishResponse(response), "2-0");
  await transport.close();

  assert.equal(backend.connected, true);
  assert.equal(backend.closed, true);
  assert.deepEqual(backend.additions, [
    {
      stream: AGENT_TASK_STREAM,
      publicationKey: agentTaskPublicationKey(deviceTask.id),
      fields: encodeAgentTask(deviceTask),
    },
    {
      stream: AGENT_RESPONSE_STREAM,
      publicationKey: agentResponsePublicationKey(response.taskId),
      fields: encodeAgentResponse(response),
    },
  ]);
});

test("publication is atomic and idempotent by task ID", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });
  const firstTaskId = await transport.publishTask(deviceTask);
  const duplicateTaskId = await transport.publishTask({
    ...deviceTask,
    instruction: "This conflicting retry must not create another entry.",
  });
  const response: AgentResponse = {
    taskId: deviceTask.id,
    agentId: deviceTask.agentId,
    message: "Mom did not answer the call.",
    timestamp: "2026-08-24T10:01:00.000Z",
  };
  const firstResponseId = await transport.publishResponse(response);
  const duplicateResponseId = await transport.publishResponse({
    ...response,
    message: "A retry returned different wording.",
  });

  assert.equal(duplicateTaskId, firstTaskId);
  assert.equal(duplicateResponseId, firstResponseId);
  assert.equal(backend.additions.length, 2);
  assert.equal(await transport.hasPublishedResponse(response.taskId), true);
  assert.equal(await transport.hasPublishedResponse("never-published"), false);
  assert.deepEqual(
    backend.additions.map(({ stream, publicationKey }) => ({
      stream,
      publicationKey,
    })),
    [
      {
        stream: AGENT_TASK_STREAM,
        publicationKey: agentTaskPublicationKey(deviceTask.id),
      },
      {
        stream: AGENT_RESPONSE_STREAM,
        publicationKey: agentResponsePublicationKey(deviceTask.id),
      },
    ],
  );
});

test("per-agent groups filter and acknowledge tasks intended for other agents", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });
  const googleTask: AgentTask = {
    ...deviceTask,
    id: "task-google",
    agentId: "google-agent",
    instruction: "Add ₹500 to the expense sheet.",
  };
  backend.readQueue.push([
    { id: "1-0", fields: encodeAgentTask(googleTask) },
    { id: "2-0", fields: encodeAgentTask(deviceTask), deliveryCount: 1 },
  ]);

  await transport.ensureTaskConsumerGroup("device-agent");
  const deliveries = await transport.readTasks("device-agent", "device-one", {
    blockMs: 25,
    count: 5,
  });

  assert.deepEqual(backend.groups, [
    { stream: AGENT_TASK_STREAM, group: "shiva-agent:device-agent" },
  ]);
  assert.deepEqual(backend.reads, [
    {
      stream: AGENT_TASK_STREAM,
      group: "shiva-agent:device-agent",
      consumer: "device-one",
      blockMs: 25,
      count: 5,
    },
  ]);
  assert.deepEqual(deliveries, [
    { streamId: "2-0", task: deviceTask, attempt: 1, recovered: false },
  ]);
  assert.deepEqual(backend.acknowledgements, [
    {
      stream: AGENT_TASK_STREAM,
      group: "shiva-agent:device-agent",
      entryId: "1-0",
    },
  ]);
});

test("XAUTOCLAIM recovery carries the durable delivery attempt and remains unacked", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });
  backend.claimQueue.push([
    { id: "7-0", fields: encodeAgentTask(deviceTask) },
  ]);
  backend.deliveryCounts.set(
    `${AGENT_TASK_STREAM}|shiva-agent:device-agent|7-0`,
    3,
  );

  const deliveries = await transport.claimStaleTasks(
    "device-agent",
    "device-after-restart",
    { minIdleMs: 2_000, count: 4 },
  );

  assert.deepEqual(backend.claims, [
    {
      stream: AGENT_TASK_STREAM,
      group: "shiva-agent:device-agent",
      consumer: "device-after-restart",
      minIdleMs: 2_000,
      count: 4,
    },
  ]);
  assert.deepEqual(deliveries, [
    { streamId: "7-0", task: deviceTask, attempt: 3, recovered: true },
  ]);
  assert.deepEqual(backend.acknowledgements, []);
});

test("Core can recover, correlate, and acknowledge plain-text responses", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });
  const response: AgentResponse = {
    taskId: deviceTask.id,
    agentId: deviceTask.agentId,
    message: "Mom did not answer the call.",
    metadata: { callId: "call-789" },
    timestamp: "2026-08-24T10:01:00.000Z",
  };
  backend.claimQueue.push([
    {
      id: "8-0",
      fields: encodeAgentResponse(response),
      deliveryCount: 2,
    },
  ]);

  await transport.ensureResponseConsumerGroup();
  const deliveries = await transport.claimStaleResponses("core-restarted", {
    group: CORE_RESPONSE_CONSUMER_GROUP,
    minIdleMs: 1_000,
  });
  await transport.acknowledgeResponse(deliveries[0]?.streamId ?? "missing");

  assert.deepEqual(deliveries, [
    { streamId: "8-0", response, attempt: 2, recovered: true },
  ]);
  assert.deepEqual(backend.acknowledgements, [
    {
      stream: AGENT_RESPONSE_STREAM,
      group: CORE_RESPONSE_CONSUMER_GROUP,
      entryId: "8-0",
    },
  ]);
});

test("heartbeat presence reports online state and stale workers cannot clear a replacement", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });

  assert.equal(await transport.isAgentOnline("device-agent"), false);
  await transport.refreshAgentHeartbeat("device-agent", "old-worker", 5_000);
  assert.equal(await transport.isAgentOnline("device-agent"), true);
  await transport.refreshAgentHeartbeat("device-agent", "new-worker", 5_000);
  await transport.clearAgentHeartbeat("device-agent", "old-worker");
  assert.equal(await transport.isAgentOnline("device-agent"), true);
  await transport.clearAgentHeartbeat("device-agent", "new-worker");
  assert.equal(await transport.isAgentOnline("device-agent"), false);
});

test("task lease renewal is scoped to the owning agent group and consumer", async () => {
  const backend = new FakeRedisBackend();
  const transport = new RedisAgentTransport({ backend });

  assert.equal(
    await transport.renewTaskLease("device-agent", "device-one", "7-0"),
    true,
  );
  assert.deepEqual(backend.leaseRenewals, [
    {
      stream: AGENT_TASK_STREAM,
      group: "shiva-agent:device-agent",
      consumer: "device-one",
      entryId: "7-0",
    },
  ]);
});

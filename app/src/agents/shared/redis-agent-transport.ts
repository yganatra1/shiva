import { createClient, type RedisClientType } from "redis";

import {
  AGENT_RESPONSE_STREAM,
  AGENT_TASK_STREAM,
  CORE_RESPONSE_CONSUMER_GROUP,
  agentHeartbeatKey,
  agentResponsePublicationKey,
  agentTaskPublicationKey,
  decodeAgentResponse,
  decodeAgentTask,
  encodeAgentResponse,
  encodeAgentTask,
  taskConsumerGroup,
  type AgentResponse,
  type AgentTask,
} from "./protocol";

const DEFAULT_READ_BLOCK_MS = 1_000;
const MAX_READ_BLOCK_MS = 5_000;
const DEFAULT_READ_COUNT = 10;
const MAX_READ_COUNT = 100;
const REDIS_CONNECT_TIMEOUT_MS = 5_000;
const REDIS_RECONNECT_BASE_DELAY_MS = 100;
const REDIS_RECONNECT_MAX_DELAY_MS = 2_000;
const REDIS_COMMAND_QUEUE_LIMIT = 100;

const ADD_ONCE_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then
  return existing
end
local entryId = redis.call('XADD', KEYS[1], '*', unpack(ARGV))
redis.call('SET', KEYS[2], entryId)
return entryId
`;

const RENEW_PENDING_ENTRY_SCRIPT = `
local pending = redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[3], ARGV[3], 1)
if #pending == 0 or pending[1][2] ~= ARGV[2] then
  return 0
end
redis.call('XCLAIM', KEYS[1], ARGV[1], ARGV[2], 0, ARGV[3], 'IDLE', 0, 'RETRYCOUNT', pending[1][4], 'JUSTID')
return 1
`;

export interface RawStreamEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly deliveryCount?: number;
}

/** Narrow boundary around node-redis, exported so transport tests need no server. */
export interface RedisAgentTransportBackend {
  connect(): Promise<void>;
  close(): Promise<void>;
  addOnce(
    stream: string,
    publicationKey: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<string>;
  ensureGroup(stream: string, group: string): Promise<void>;
  readGroup(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly blockMs: number;
    readonly count: number;
  }): Promise<readonly RawStreamEntry[]>;
  autoClaim(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly minIdleMs: number;
    readonly count: number;
  }): Promise<readonly RawStreamEntry[]>;
  deliveryCount(stream: string, group: string, entryId: string): Promise<number>;
  acknowledge(stream: string, group: string, entryId: string): Promise<void>;
  renewPendingEntry(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly entryId: string;
  }): Promise<boolean>;
  getPublication(publicationKey: string): Promise<string | null>;
  setHeartbeat(key: string, consumer: string, ttlMs: number): Promise<void>;
  getHeartbeat(key: string): Promise<string | null>;
  removeHeartbeat(key: string, consumer: string): Promise<void>;
}

export interface RedisAgentTransportOptions {
  readonly redisUrl?: string;
  readonly taskStream?: string;
  readonly responseStream?: string;
  readonly backend?: RedisAgentTransportBackend;
  readonly onRedisError?: (error: unknown) => void;
}

export interface TaskReadOptions {
  readonly blockMs?: number;
  readonly count?: number;
}

export interface ClaimOptions {
  readonly minIdleMs: number;
  readonly count?: number;
}

export interface AgentTaskDelivery {
  readonly streamId: string;
  readonly task: AgentTask;
  readonly attempt: number;
  readonly recovered: boolean;
}

export interface AgentResponseDelivery {
  readonly streamId: string;
  readonly response: AgentResponse;
  readonly attempt: number;
  readonly recovered: boolean;
}

/**
 * Redis Streams transport only. It routes/correlates envelopes but deliberately
 * knows nothing about execution plans, steps, or semantic completion states.
 */
export class RedisAgentTransport {
  private readonly backend: RedisAgentTransportBackend;
  private readonly taskStream: string;
  private readonly responseStream: string;

  constructor(options: RedisAgentTransportOptions) {
    if (!options.backend && !options.redisUrl) {
      throw new Error("RedisAgentTransport requires redisUrl or an injected backend.");
    }
    this.backend =
      options.backend ??
      new NodeRedisAgentTransportBackend(
        options.redisUrl as string,
        options.onRedisError,
      );
    this.taskStream = normalizeStreamName(options.taskStream, AGENT_TASK_STREAM);
    this.responseStream = normalizeStreamName(
      options.responseStream,
      AGENT_RESPONSE_STREAM,
    );
  }

  connect(): Promise<void> {
    return this.backend.connect();
  }

  close(): Promise<void> {
    return this.backend.close();
  }

  publishTask(task: AgentTask): Promise<string> {
    return this.backend.addOnce(
      this.taskStream,
      agentTaskPublicationKey(task.id),
      encodeAgentTask(task),
    );
  }

  publishResponse(response: AgentResponse): Promise<string> {
    return this.backend.addOnce(
      this.responseStream,
      agentResponsePublicationKey(response.taskId),
      encodeAgentResponse(response),
    );
  }

  /**
   * Closes the response-XADD/task-XACK crash window. A restarted worker can
   * acknowledge a still-pending task without repeating its external action
   * when that task's response was already durably appended.
   */
  async hasPublishedResponse(taskId: string): Promise<boolean> {
    return (
      (await this.backend.getPublication(
        agentResponsePublicationKey(taskId),
      )) !== null
    );
  }

  ensureTaskConsumerGroup(agentId: string): Promise<void> {
    return this.backend.ensureGroup(this.taskStream, taskConsumerGroup(agentId));
  }

  ensureResponseConsumerGroup(
    group = CORE_RESPONSE_CONSUMER_GROUP,
  ): Promise<void> {
    return this.backend.ensureGroup(this.responseStream, normalizeGroup(group));
  }

  async readTasks(
    agentId: string,
    consumer: string,
    options: TaskReadOptions = {},
  ): Promise<readonly AgentTaskDelivery[]> {
    const group = taskConsumerGroup(agentId);
    const entries = await this.backend.readGroup({
      stream: this.taskStream,
      group,
      consumer: normalizeConsumer(consumer),
      blockMs: readBlockMs(options.blockMs),
      count: readCount(options.count),
    });
    return this.decodeTasksForAgent(entries, agentId, group, false);
  }

  async claimStaleTasks(
    agentId: string,
    consumer: string,
    options: ClaimOptions,
  ): Promise<readonly AgentTaskDelivery[]> {
    const group = taskConsumerGroup(agentId);
    const entries = await this.backend.autoClaim({
      stream: this.taskStream,
      group,
      consumer: normalizeConsumer(consumer),
      minIdleMs: nonNegativeInteger(options.minIdleMs, "minIdleMs"),
      count: readCount(options.count),
    });
    return this.decodeTasksForAgent(entries, agentId, group, true);
  }

  acknowledgeTask(agentId: string, streamId: string): Promise<void> {
    return this.backend.acknowledge(
      this.taskStream,
      taskConsumerGroup(agentId),
      normalizeEntryId(streamId),
    );
  }

  renewTaskLease(
    agentId: string,
    consumer: string,
    streamId: string,
  ): Promise<boolean> {
    return this.backend.renewPendingEntry({
      stream: this.taskStream,
      group: taskConsumerGroup(agentId),
      consumer: normalizeConsumer(consumer),
      entryId: normalizeEntryId(streamId),
    });
  }

  async readResponses(
    consumer: string,
    options: TaskReadOptions & { readonly group?: string } = {},
  ): Promise<readonly AgentResponseDelivery[]> {
    const group = normalizeGroup(options.group ?? CORE_RESPONSE_CONSUMER_GROUP);
    const entries = await this.backend.readGroup({
      stream: this.responseStream,
      group,
      consumer: normalizeConsumer(consumer),
      blockMs: readBlockMs(options.blockMs),
      count: readCount(options.count),
    });
    return this.decodeResponses(entries, group, false);
  }

  async claimStaleResponses(
    consumer: string,
    options: ClaimOptions & { readonly group?: string },
  ): Promise<readonly AgentResponseDelivery[]> {
    const group = normalizeGroup(options.group ?? CORE_RESPONSE_CONSUMER_GROUP);
    const entries = await this.backend.autoClaim({
      stream: this.responseStream,
      group,
      consumer: normalizeConsumer(consumer),
      minIdleMs: nonNegativeInteger(options.minIdleMs, "minIdleMs"),
      count: readCount(options.count),
    });
    return this.decodeResponses(entries, group, true);
  }

  acknowledgeResponse(
    streamId: string,
    group = CORE_RESPONSE_CONSUMER_GROUP,
  ): Promise<void> {
    return this.backend.acknowledge(
      this.responseStream,
      normalizeGroup(group),
      normalizeEntryId(streamId),
    );
  }

  refreshAgentHeartbeat(
    agentId: string,
    consumer: string,
    ttlMs: number,
  ): Promise<void> {
    return this.backend.setHeartbeat(
      agentHeartbeatKey(agentId),
      normalizeConsumer(consumer),
      positiveInteger(ttlMs, "ttlMs"),
    );
  }

  async isAgentOnline(agentId: string): Promise<boolean> {
    return (await this.backend.getHeartbeat(agentHeartbeatKey(agentId))) !== null;
  }

  clearAgentHeartbeat(agentId: string, consumer: string): Promise<void> {
    return this.backend.removeHeartbeat(
      agentHeartbeatKey(agentId),
      normalizeConsumer(consumer),
    );
  }

  private async decodeTasksForAgent(
    entries: readonly RawStreamEntry[],
    agentId: string,
    group: string,
    recovered: boolean,
  ): Promise<readonly AgentTaskDelivery[]> {
    const deliveries: AgentTaskDelivery[] = [];
    for (const entry of entries) {
      let task: AgentTask;
      try {
        task = decodeAgentTask(entry.fields);
      } catch (error: unknown) {
        // A permanently malformed envelope must not poison the consumer group.
        await this.backend.acknowledge(this.taskStream, group, entry.id);
        throw error;
      }
      if (task.agentId !== agentId) {
        // Every per-agent group sees the shared stream. Irrelevant entries are
        // acknowledged only in this group; the target agent's group still sees them.
        await this.backend.acknowledge(this.taskStream, group, entry.id);
        continue;
      }
      deliveries.push({
        streamId: entry.id,
        task,
        attempt: await this.resolveDeliveryCount(entry, group, this.taskStream),
        recovered,
      });
    }
    return deliveries;
  }

  private async decodeResponses(
    entries: readonly RawStreamEntry[],
    group: string,
    recovered: boolean,
  ): Promise<readonly AgentResponseDelivery[]> {
    const deliveries: AgentResponseDelivery[] = [];
    for (const entry of entries) {
      let response: AgentResponse;
      try {
        response = decodeAgentResponse(entry.fields);
      } catch (error: unknown) {
        await this.backend.acknowledge(this.responseStream, group, entry.id);
        throw error;
      }
      deliveries.push({
        streamId: entry.id,
        response,
        attempt: await this.resolveDeliveryCount(entry, group, this.responseStream),
        recovered,
      });
    }
    return deliveries;
  }

  private async resolveDeliveryCount(
    entry: RawStreamEntry,
    group: string,
    stream: string,
  ): Promise<number> {
    if (entry.deliveryCount !== undefined) {
      return Math.max(1, entry.deliveryCount);
    }
    return Math.max(1, await this.backend.deliveryCount(stream, group, entry.id));
  }
}

class NodeRedisAgentTransportBackend implements RedisAgentTransportBackend {
  private readonly commandClient: RedisClientType;
  private readonly blockingClient: RedisClientType;
  private connected = false;
  private closed = false;

  constructor(redisUrl: string, onRedisError: ((error: unknown) => void) | undefined) {
    const reportError = onRedisError ?? (() => {});
    this.commandClient = createClient({
      url: redisUrl,
      commandsQueueMaxLength: REDIS_COMMAND_QUEUE_LIMIT,
      // A disconnected process must fail work back to its bounded worker retry
      // loop instead of accumulating an unbounded in-memory command queue.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: cappedReconnectDelay,
      },
    });
    this.blockingClient = this.commandClient.duplicate();
    this.commandClient.on("error", reportError);
    this.blockingClient.on("error", reportError);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closed) throw new Error("Redis transport is closed.");
    try {
      await Promise.all([
        this.commandClient.connect(),
        this.blockingClient.connect(),
      ]);
      this.connected = true;
    } catch (error: unknown) {
      this.commandClient.destroy();
      this.blockingClient.destroy();
      this.closed = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Destroy the blocking connection so shutdown does not wait for XREADGROUP.
    if (this.blockingClient.isOpen) this.blockingClient.destroy();
    if (this.commandClient.isOpen) this.commandClient.destroy();
    this.connected = false;
  }

  async addOnce(
    stream: string,
    publicationKey: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<string> {
    const result = await this.commandClient.eval(ADD_ONCE_SCRIPT, {
      keys: [stream, publicationKey],
      arguments: Object.entries(fields).flatMap(([key, value]) => [key, value]),
    });
    if (typeof result !== "string") {
      throw new Error("Redis did not return a stream ID for the publication.");
    }
    return result;
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.commandClient.xGroupCreate(stream, group, "0", {
        MKSTREAM: true,
      });
    } catch (error: unknown) {
      if (!isBusyGroupError(error)) throw error;
    }
  }

  async readGroup(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly blockMs: number;
    readonly count: number;
  }): Promise<readonly RawStreamEntry[]> {
    const streams = await this.blockingClient.xReadGroup(
      input.group,
      input.consumer,
      { key: input.stream, id: ">" },
      { COUNT: input.count, BLOCK: input.blockMs },
    );
    return flattenStreamEntries(streams);
  }

  async autoClaim(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly minIdleMs: number;
    readonly count: number;
  }): Promise<readonly RawStreamEntry[]> {
    const result = await this.commandClient.xAutoClaim(
      input.stream,
      input.group,
      input.consumer,
      input.minIdleMs,
      "0-0",
      { COUNT: input.count },
    );
    return result.messages
      .filter((entry) => entry !== null)
      .map((entry) => ({
        id: String(entry.id),
        fields: stringRecord(entry.message),
        ...(entry.deliveriesCounter !== undefined
          ? { deliveryCount: Number(entry.deliveriesCounter) }
          : {}),
      }));
  }

  async deliveryCount(
    stream: string,
    group: string,
    entryId: string,
  ): Promise<number> {
    const pending = await this.commandClient.xPendingRange(
      stream,
      group,
      entryId,
      entryId,
      1,
    );
    return pending[0]?.deliveriesCounter ?? 1;
  }

  async acknowledge(
    stream: string,
    group: string,
    entryId: string,
  ): Promise<void> {
    await this.commandClient.xAck(stream, group, entryId);
  }

  async renewPendingEntry(input: {
    readonly stream: string;
    readonly group: string;
    readonly consumer: string;
    readonly entryId: string;
  }): Promise<boolean> {
    const result = await this.commandClient.eval(RENEW_PENDING_ENTRY_SCRIPT, {
      keys: [input.stream],
      arguments: [input.group, input.consumer, input.entryId],
    });
    return Number(result) === 1;
  }

  getPublication(publicationKey: string): Promise<string | null> {
    return this.commandClient.get(publicationKey);
  }

  async setHeartbeat(key: string, consumer: string, ttlMs: number): Promise<void> {
    await this.commandClient.set(key, consumer, {
      expiration: { type: "PX", value: ttlMs },
    });
  }

  getHeartbeat(key: string): Promise<string | null> {
    return this.commandClient.get(key);
  }

  async removeHeartbeat(key: string, consumer: string): Promise<void> {
    await this.commandClient.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [consumer] },
    );
  }
}

function flattenStreamEntries(
  streams: Awaited<ReturnType<RedisClientType["xReadGroup"]>>,
): readonly RawStreamEntry[] {
  if (!streams) return [];
  return streams.flatMap((stream) =>
    stream.messages.map((entry) => ({
      id: String(entry.id),
      fields: stringRecord(entry.message),
      ...(entry.deliveriesCounter !== undefined
        ? { deliveryCount: Number(entry.deliveriesCounter) }
        : {}),
    })),
  );
}

function stringRecord(value: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, String(field)]),
  );
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && /\bBUSYGROUP\b/.test(error.message);
}

function cappedReconnectDelay(retries: number): number {
  // This is connection recovery, not redelivery of an external action. Keep
  // attempting while the long-running Core process is alive, but cap every
  // delay and keep the offline command queue disabled so an outage cannot
  // spin, hang requests, or accumulate unbounded in-memory work. Agent task
  // execution itself remains bounded independently by maxAttempts/deadlines.
  return Math.min(
    REDIS_RECONNECT_MAX_DELAY_MS,
    REDIS_RECONNECT_BASE_DELAY_MS * 2 ** retries,
  );
}

function normalizeStreamName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length > 255) throw new Error("Redis stream names are limited to 255 characters.");
  return normalized;
}

function normalizeGroup(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new Error("Redis consumer group names must contain 1-255 characters.");
  }
  return normalized;
}

function normalizeConsumer(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new Error("Redis consumer names must contain 1-255 characters.");
  }
  return normalized;
}

function normalizeEntryId(value: string): string {
  const normalized = value.trim();
  if (!/^\d+-\d+$/.test(normalized)) {
    throw new Error("Redis stream entry IDs must use the '<milliseconds>-<sequence>' form.");
  }
  return normalized;
}

function readBlockMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_BLOCK_MS;
  const normalized = positiveInteger(value, "blockMs");
  if (normalized > MAX_READ_BLOCK_MS) {
    throw new Error(`blockMs cannot exceed ${MAX_READ_BLOCK_MS}.`);
  }
  return normalized;
}

function readCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_COUNT;
  const normalized = positiveInteger(value, "count");
  if (normalized > MAX_READ_COUNT) {
    throw new Error(`count cannot exceed ${MAX_READ_COUNT}.`);
  }
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

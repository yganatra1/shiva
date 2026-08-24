import { z } from "zod";

export const AGENT_TASK_STREAM = "shiva:agent:tasks";
export const AGENT_RESPONSE_STREAM = "shiva:agent:responses";
export const CORE_RESPONSE_CONSUMER_GROUP = "shiva-core";
const AGENT_PUBLICATION_KEY_PREFIX = "shiva:agent:published";

const identifierSchema = z.string().trim().min(1).max(255);
const timestampSchema = z.string().datetime({ offset: true });

const agentTaskSchema = z
  .object({
    id: identifierSchema,
    conversationId: identifierSchema,
    agentId: identifierSchema,
    instruction: z.string().trim().min(1).max(20_000),
    createdAt: timestampSchema,
    deadlineAt: timestampSchema.optional(),
  })
  .strict();

const agentResponseSchema = z
  .object({
    taskId: identifierSchema,
    agentId: identifierSchema,
    message: z.string().trim().min(1).max(20_000),
    metadata: z.record(z.string(), z.unknown()).optional(),
    timestamp: timestampSchema,
  })
  .strict();

export interface AgentTask {
  readonly id: string;
  readonly conversationId: string;
  readonly agentId: string;
  /** Self-contained natural-language context; semantic task state does not live in JSON. */
  readonly instruction: string;
  readonly createdAt: string;
  /** Technical delivery deadline; not semantic workflow state. */
  readonly deadlineAt?: string;
}

export interface AgentResponse {
  readonly taskId: string;
  readonly agentId: string;
  /** The agent's plain natural-language report to Shiva Core. */
  readonly message: string;
  /** Optional transport/provider diagnostics, never semantic orchestration state. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export type AgentTaskFields = Readonly<Record<string, string>>;
export type AgentResponseFields = Readonly<Record<string, string>>;

export class AgentProtocolError extends Error {
  override readonly name = "AgentProtocolError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function encodeAgentTask(task: AgentTask): AgentTaskFields {
  const parsed = parseTask(task);
  return {
    id: parsed.id,
    conversationId: parsed.conversationId,
    agentId: parsed.agentId,
    instruction: parsed.instruction,
    createdAt: parsed.createdAt,
    ...(parsed.deadlineAt ? { deadlineAt: parsed.deadlineAt } : {}),
  };
}

export function decodeAgentTask(fields: Readonly<Record<string, string>>): AgentTask {
  return parseTask({
    id: fields.id,
    conversationId: fields.conversationId,
    agentId: fields.agentId,
    instruction: fields.instruction,
    createdAt: fields.createdAt,
    ...(fields.deadlineAt !== undefined
      ? { deadlineAt: fields.deadlineAt }
      : {}),
  });
}

export function encodeAgentResponse(response: AgentResponse): AgentResponseFields {
  const parsed = parseResponse(response);
  return {
    taskId: parsed.taskId,
    agentId: parsed.agentId,
    message: parsed.message,
    ...(parsed.metadata ? { metadata: stringifyMetadata(parsed.metadata) } : {}),
    timestamp: parsed.timestamp,
  };
}

export function decodeAgentResponse(
  fields: Readonly<Record<string, string>>,
): AgentResponse {
  return parseResponse({
    taskId: fields.taskId,
    agentId: fields.agentId,
    message: fields.message,
    ...(fields.metadata !== undefined
      ? { metadata: parseMetadata(fields.metadata) }
      : {}),
    timestamp: fields.timestamp,
  });
}

/** One consumer group per agent is required because Redis Streams cannot filter by field. */
export function taskConsumerGroup(agentId: string): string {
  const parsed = identifierSchema.safeParse(agentId);
  if (!parsed.success) {
    throw new AgentProtocolError("Agent IDs must be non-empty identifiers.");
  }
  return `shiva-agent:${parsed.data}`;
}

export function agentHeartbeatKey(agentId: string): string {
  const parsed = identifierSchema.safeParse(agentId);
  if (!parsed.success) {
    throw new AgentProtocolError("Agent IDs must be non-empty identifiers.");
  }
  return `shiva:agent:heartbeat:${parsed.data}`;
}

/**
 * Redis key used by the transport's atomic XADD deduplication script. Task IDs
 * are opaque correlation IDs, so encode them before including them in a key.
 */
export function agentTaskPublicationKey(taskId: string): string {
  return publicationKey("task", taskId);
}

/** One natural-language response may be published for each delegated task. */
export function agentResponsePublicationKey(taskId: string): string {
  return publicationKey("response", taskId);
}

function publicationKey(kind: "task" | "response", taskId: string): string {
  const parsed = identifierSchema.safeParse(taskId);
  if (!parsed.success) {
    throw new AgentProtocolError("Task IDs must be non-empty identifiers.");
  }
  return `${AGENT_PUBLICATION_KEY_PREFIX}:${kind}:${encodeURIComponent(parsed.data)}`;
}

function parseTask(value: unknown): AgentTask {
  const parsed = agentTaskSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentProtocolError("Invalid agent task transport envelope.");
  }
  const {
    id,
    conversationId,
    agentId,
    instruction,
    createdAt,
    deadlineAt,
  } = parsed.data;
  return {
    id,
    conversationId,
    agentId,
    instruction,
    createdAt,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  };
}

function parseResponse(value: unknown): AgentResponse {
  const parsed = agentResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentProtocolError("Invalid agent response transport envelope.");
  }
  const { taskId, agentId, message, metadata, timestamp } = parsed.data;
  return {
    taskId,
    agentId,
    message,
    ...(metadata !== undefined ? { metadata } : {}),
    timestamp,
  };
}

function stringifyMetadata(metadata: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(metadata);
  } catch (error: unknown) {
    throw new AgentProtocolError("Agent response metadata must be JSON serializable.", {
      cause: error,
    });
  }
}

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new AgentProtocolError("Agent response metadata is not valid JSON.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new AgentProtocolError("Agent response metadata must be a JSON object.");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool";
import { actionConfirmations } from "../database/schema";
import {
  sanitizeAuditPayload,
  sanitizeAuditText,
} from "./audit-sanitizer";
import type {
  ActionImpact,
  ActionMutability,
  ExecutionMode,
} from "./execution-mode";

export const CONFIRMATION_STATUSES = [
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

/**
 * Authoritative Core context captured when an action first asks for consent.
 * It lets an approval turn such as "yes" execute the original request without
 * treating that short approval as a new delegated objective.
 */
export interface ConfirmationOriginContext {
  readonly originalUserRequest?: string;
  readonly sourceMessageId?: string;
  readonly orchestrationRequestId?: string;
  readonly agentResponseId?: string;
}

export interface ActionConfirmation {
  readonly id: string;
  readonly agentRunId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly skill: string;
  readonly sanitizedArguments: unknown;
  readonly originContext: ConfirmationOriginContext;
  readonly actionHash: string;
  readonly reason: string;
  readonly executionMode: ExecutionMode;
  readonly mutability: ActionMutability;
  readonly impact: ActionImpact;
  readonly settingsRevision: number;
  readonly status: ConfirmationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
}

export type NewActionConfirmation = Omit<
  ActionConfirmation,
  "status" | "resolvedAt" | "resolvedBy"
>;

interface ReplacedConfirmation {
  readonly confirmation: ActionConfirmation;
  readonly replaced: readonly ActionConfirmation[];
}

interface PendingConfirmationLookup {
  readonly pending?: ActionConfirmation;
  readonly expired: readonly ActionConfirmation[];
  /** Recent terminal records are replayed so Core restart cannot lose cleanup. */
  readonly terminal: readonly ActionConfirmation[];
}

export type ConfirmationTerminalOutcome = Exclude<
  ConfirmationResolution["outcome"],
  "approved" | "not_found"
>;

export interface ConfirmationTerminalEvent {
  readonly confirmation: ActionConfirmation;
  readonly outcome: ConfirmationTerminalOutcome;
  readonly now: Date;
}

export type ConfirmationTerminalObserver = (
  event: ConfirmationTerminalEvent,
) => Promise<void>;

export interface ConfirmationStore {
  replacePending(input: NewActionConfirmation): Promise<ReplacedConfirmation>;
  findById(id: string): Promise<ActionConfirmation | undefined>;
  findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<PendingConfirmationLookup>;
  transition(
    id: string,
    from: ConfirmationStatus,
    to: ConfirmationStatus,
    resolvedAt: Date,
    resolvedBy: string | null,
  ): Promise<ActionConfirmation | undefined>;
  invalidatePending(resolvedAt: Date): Promise<readonly ActionConfirmation[]>;
}

export class DrizzleConfirmationStore implements ConfirmationStore {
  constructor(private readonly db: ShivaDatabase) {}

  async replacePending(
    input: NewActionConfirmation,
  ): Promise<ReplacedConfirmation> {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${input.conversationId}`}, 0))`,
      );
      const replaced = await transaction
        .update(actionConfirmations)
        .set({
          status: "DENIED",
          resolvedAt: input.createdAt,
          resolvedBy: input.userId,
        })
        .where(
          and(
            eq(actionConfirmations.userId, input.userId),
            eq(actionConfirmations.conversationId, input.conversationId),
            eq(actionConfirmations.status, "PENDING"),
          ),
        )
        .returning();
      const [created] = await transaction
        .insert(actionConfirmations)
        .values(input)
        .returning();
      if (!created) throw new Error("The confirmation could not be persisted.");
      return { confirmation: created, replaced };
    });
  }

  async findById(id: string): Promise<ActionConfirmation | undefined> {
    const [confirmation] = await this.db
      .select()
      .from(actionConfirmations)
      .where(eq(actionConfirmations.id, id))
      .limit(1);
    return confirmation;
  }

  async findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<PendingConfirmationLookup> {
    const expired = await this.db
      .update(actionConfirmations)
      .set({ status: "EXPIRED", resolvedAt: now })
      .where(
        and(
          eq(actionConfirmations.userId, userId),
          ...(conversationId
            ? [eq(actionConfirmations.conversationId, conversationId)]
            : []),
          eq(actionConfirmations.status, "PENDING"),
          lte(actionConfirmations.expiresAt, now),
        ),
      )
      .returning();
    const [confirmation] = await this.db
      .select()
      .from(actionConfirmations)
      .where(
        and(
          eq(actionConfirmations.userId, userId),
          ...(conversationId
            ? [eq(actionConfirmations.conversationId, conversationId)]
            : []),
          eq(actionConfirmations.status, "PENDING"),
        ),
      )
      .orderBy(desc(actionConfirmations.createdAt))
      .limit(1);
    const terminal = await this.db
      .select()
      .from(actionConfirmations)
      .where(
        and(
          eq(actionConfirmations.userId, userId),
          ...(conversationId
            ? [eq(actionConfirmations.conversationId, conversationId)]
            : []),
          inArray(actionConfirmations.status, ["DENIED", "EXPIRED", "FAILED"]),
        ),
      )
      .orderBy(desc(actionConfirmations.resolvedAt))
      .limit(100);
    return {
      ...(confirmation ? { pending: confirmation } : {}),
      expired,
      terminal,
    };
  }

  async transition(
    id: string,
    from: ConfirmationStatus,
    to: ConfirmationStatus,
    resolvedAt: Date,
    resolvedBy: string | null,
  ): Promise<ActionConfirmation | undefined> {
    const [updated] = await this.db
      .update(actionConfirmations)
      .set({ status: to, resolvedAt, resolvedBy })
      .where(
        and(
          eq(actionConfirmations.id, id),
          eq(actionConfirmations.status, from),
        ),
      )
      .returning();
    return updated;
  }

  async invalidatePending(
    resolvedAt: Date,
  ): Promise<readonly ActionConfirmation[]> {
    return this.db
      .update(actionConfirmations)
      .set({ status: "DENIED", resolvedAt })
      .where(
        inArray(actionConfirmations.status, ["PENDING", "APPROVED"]),
      )
      .returning();
  }
}

export class InMemoryConfirmationStore implements ConfirmationStore {
  constructor(
    private readonly records: Map<string, ActionConfirmation> = new Map(),
  ) {}

  async replacePending(
    input: NewActionConfirmation,
  ): Promise<ReplacedConfirmation> {
    const replaced: ActionConfirmation[] = [];
    for (const [id, record] of this.records) {
      if (
        record.userId === input.userId &&
        record.conversationId === input.conversationId &&
        record.status === "PENDING"
      ) {
        const denied: ActionConfirmation = {
          ...record,
          status: "DENIED",
          resolvedAt: input.createdAt,
          resolvedBy: input.userId,
        };
        this.records.set(id, denied);
        replaced.push({ ...denied });
      }
    }
    const created: ActionConfirmation = {
      ...input,
      status: "PENDING",
      resolvedAt: null,
      resolvedBy: null,
    };
    this.records.set(created.id, created);
    return { confirmation: { ...created }, replaced };
  }

  async findById(id: string): Promise<ActionConfirmation | undefined> {
    const confirmation = this.records.get(id);
    return confirmation ? { ...confirmation } : undefined;
  }

  async findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<PendingConfirmationLookup> {
    const candidates = [...this.records.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          (conversationId === undefined ||
            record.conversationId === conversationId) &&
          record.status === "PENDING",
      )
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      );
    const expired: ActionConfirmation[] = [];
    for (const candidate of candidates) {
      if (candidate.expiresAt.getTime() > now.getTime()) continue;
      const transitioned = await this.transition(
        candidate.id,
        "PENDING",
        "EXPIRED",
        now,
        null,
      );
      if (transitioned) expired.push(transitioned);
    }
    const pending = candidates.find(
      (candidate) => candidate.expiresAt.getTime() > now.getTime(),
    );
    const terminal = [...this.records.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          (conversationId === undefined ||
            record.conversationId === conversationId) &&
          (record.status === "DENIED" ||
            record.status === "EXPIRED" ||
            record.status === "FAILED"),
      )
      .sort(
        (left, right) =>
          (right.resolvedAt?.getTime() ?? 0) -
          (left.resolvedAt?.getTime() ?? 0),
      )
      .slice(0, 100);
    return {
      ...(pending ? { pending: { ...pending } } : {}),
      expired,
      terminal,
    };
  }

  async transition(
    id: string,
    from: ConfirmationStatus,
    to: ConfirmationStatus,
    resolvedAt: Date,
    resolvedBy: string | null,
  ): Promise<ActionConfirmation | undefined> {
    const current = this.records.get(id);
    if (!current || current.status !== from) return undefined;
    const updated: ActionConfirmation = {
      ...current,
      status: to,
      resolvedAt,
      resolvedBy,
    };
    this.records.set(id, updated);
    return { ...updated };
  }

  async invalidatePending(
    resolvedAt: Date,
  ): Promise<readonly ActionConfirmation[]> {
    const invalidated: ActionConfirmation[] = [];
    for (const [id, record] of this.records) {
      if (record.status === "PENDING" || record.status === "APPROVED") {
        const denied: ActionConfirmation = {
          ...record,
          status: "DENIED",
          resolvedAt,
          resolvedBy: null,
        };
        this.records.set(id, denied);
        invalidated.push({ ...denied });
      }
    }
    return invalidated;
  }
}

export interface ConfirmationResolution {
  readonly outcome:
    | "approved"
    | "denied"
    | "expired"
    | "mismatch"
    | "not_found"
    | "already_resolved";
  readonly confirmation?: ActionConfirmation;
}

export class ConfirmationService {
  private readonly notifiedTerminalIds = new Set<string>();

  constructor(
    private readonly store: ConfirmationStore,
    private readonly ttlMs: number,
    private readonly createId: () => string = () => randomUUID(),
    private readonly onTerminal: ConfirmationTerminalObserver = async () => {},
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) {
      throw new RangeError("Confirmation TTL must be 1000-3600000ms.");
    }
  }

  async request(input: {
    readonly agentRunId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly skill: string;
    readonly arguments: unknown;
    readonly originContext?: ConfirmationOriginContext;
    readonly reason: string;
    readonly executionMode: ExecutionMode;
    readonly mutability: ActionMutability;
    readonly impact: ActionImpact;
    readonly settingsRevision: number;
    readonly now: Date;
  }): Promise<ActionConfirmation> {
    const result = await this.store.replacePending({
      id: this.createId(),
      agentRunId: input.agentRunId,
      userId: input.userId,
      conversationId: input.conversationId,
      skill: input.skill,
      sanitizedArguments: sanitizeAuditPayload(input.arguments),
      originContext: normalizeOriginContext(input.originContext),
      actionHash: actionFingerprint(input.skill, input.arguments),
      reason: sanitizeAuditText(input.reason, 500),
      executionMode: input.executionMode,
      mutability: input.mutability,
      impact: input.impact,
      settingsRevision: input.settingsRevision,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + this.ttlMs),
    });
    for (const replaced of result.replaced) {
      await this.notifyTerminal(replaced, "denied", input.now);
    }
    return result.confirmation;
  }

  async findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<ActionConfirmation | undefined> {
    const result = await this.store.findPending(userId, conversationId, now);
    for (const expired of result.expired) {
      await this.notifyTerminal(expired, "expired", now);
    }
    for (const terminal of result.terminal) {
      const outcome = terminalOutcomeForStatus(terminal.status);
      if (outcome) await this.notifyTerminal(terminal, outcome, now);
    }
    return result.pending;
  }

  async resolve(input: {
    readonly id: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly approved: boolean;
    readonly skill?: string;
    readonly arguments?: unknown;
    readonly now: Date;
  }): Promise<ConfirmationResolution> {
    const confirmation = await this.store.findById(input.id);
    if (
      !confirmation ||
      confirmation.userId !== input.userId ||
      confirmation.conversationId !== input.conversationId
    ) {
      return { outcome: "not_found" };
    }
    if (confirmation.status !== "PENDING") {
      // A replay of an EXECUTED confirmation may belong to a delegation that
      // already queued its next task, so it is not itself a terminal request
      // signal. Only records that are already terminal without a successful
      // action get a best-effort lifecycle retry here.
      const terminalOutcome = terminalOutcomeForStatus(confirmation.status);
      if (terminalOutcome) {
        await this.notifyTerminal(confirmation, terminalOutcome, input.now);
      }
      return { outcome: "already_resolved", confirmation };
    }
    if (confirmation.expiresAt.getTime() <= input.now.getTime()) {
      const expired = await this.store.transition(
        confirmation.id,
        "PENDING",
        "EXPIRED",
        input.now,
        null,
      );
      if (!expired) {
        return this.resolvedElsewhere(confirmation, input.now);
      }
      await this.notifyTerminal(expired, "expired", input.now);
      return { outcome: "expired", confirmation: expired };
    }
    if (!input.approved) {
      const denied = await this.store.transition(
        confirmation.id,
        "PENDING",
        "DENIED",
        input.now,
        input.userId,
      );
      if (denied) {
        await this.notifyTerminal(denied, "denied", input.now);
        return { outcome: "denied", confirmation: denied };
      }
      return this.resolvedElsewhere(confirmation, input.now);
    }
    const matches =
      input.skill === confirmation.skill &&
      actionFingerprint(input.skill, input.arguments) === confirmation.actionHash;
    if (!matches) {
      const denied = await this.store.transition(
        confirmation.id,
        "PENDING",
        "DENIED",
        input.now,
        input.userId,
      );
      if (!denied) {
        return this.resolvedElsewhere(confirmation, input.now);
      }
      await this.notifyTerminal(denied, "mismatch", input.now);
      return { outcome: "mismatch", confirmation: denied };
    }
    const approved = await this.store.transition(
      confirmation.id,
      "PENDING",
      "APPROVED",
      input.now,
      input.userId,
    );
    return approved
      ? { outcome: "approved", confirmation: approved }
      : this.resolvedElsewhere(confirmation, input.now);
  }

  async claim(
    id: string,
    userId: string,
    settingsRevision: number,
    now: Date,
  ): Promise<ActionConfirmation | undefined> {
    const confirmation = await this.store.findById(id);
    if (
      !confirmation ||
      confirmation.userId !== userId ||
      confirmation.settingsRevision !== settingsRevision
    ) {
      return undefined;
    }
    return this.store.transition(
      id,
      "APPROVED",
      "EXECUTING",
      now,
      userId,
    );
  }

  complete(
    id: string,
    userId: string,
    now: Date,
    succeeded: boolean,
  ): Promise<ActionConfirmation | undefined> {
    return this.store.transition(
      id,
      "EXECUTING",
      succeeded ? "EXECUTED" : "FAILED",
      now,
      userId,
    );
  }

  failApproved(
    id: string,
    userId: string,
    now: Date,
  ): Promise<ActionConfirmation | undefined> {
    return this.store.transition(id, "APPROVED", "FAILED", now, userId);
  }

  async invalidatePending(now: Date): Promise<void> {
    const invalidated = await this.store.invalidatePending(now);
    for (const confirmation of invalidated) {
      await this.notifyTerminal(confirmation, "denied", now);
    }
  }

  private notifyTerminal(
    confirmation: ActionConfirmation,
    outcome: ConfirmationTerminalOutcome,
    now: Date,
  ): Promise<void> {
    if (this.notifiedTerminalIds.has(confirmation.id)) return Promise.resolve();
    return this.onTerminal({ confirmation, outcome, now }).then(() => {
      this.notifiedTerminalIds.add(confirmation.id);
    });
  }

  private async resolvedElsewhere(
    fallback: ActionConfirmation,
    now: Date,
  ): Promise<ConfirmationResolution> {
    const current = (await this.store.findById(fallback.id)) ?? fallback;
    const terminalOutcome = terminalOutcomeForStatus(current.status);
    if (terminalOutcome) {
      await this.notifyTerminal(current, terminalOutcome, now);
    }
    return { outcome: "already_resolved", confirmation: current };
  }
}

function normalizeOriginContext(
  context: ConfirmationOriginContext | undefined,
): ConfirmationOriginContext {
  if (!context) return {};
  return {
    ...(context.originalUserRequest
      ? { originalUserRequest: context.originalUserRequest }
      : {}),
    ...(context.sourceMessageId
      ? { sourceMessageId: context.sourceMessageId }
      : {}),
    ...(context.orchestrationRequestId
      ? { orchestrationRequestId: context.orchestrationRequestId }
      : {}),
    ...(context.agentResponseId
      ? { agentResponseId: context.agentResponseId }
      : {}),
  };
}

function terminalOutcomeForStatus(
  status: ConfirmationStatus,
): ConfirmationTerminalOutcome | undefined {
  switch (status) {
    case "DENIED":
      return "denied";
    case "EXPIRED":
      return "expired";
    case "FAILED":
      return "already_resolved";
    case "PENDING":
    case "APPROVED":
    case "EXECUTING":
    case "EXECUTED":
      return undefined;
  }
}

export function actionFingerprint(skill: string, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ skill, arguments: input }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) {
    throw new TypeError("Action arguments must be JSON-safe.");
  }
  return encoded;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Action arguments must be JSON-safe.");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : canonicalValue(entry),
    );
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  throw new TypeError("Action arguments must be JSON-safe.");
}

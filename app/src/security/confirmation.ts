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

export interface ActionConfirmation {
  readonly id: string;
  readonly agentRunId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly skill: string;
  readonly sanitizedArguments: unknown;
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

export interface ConfirmationStore {
  replacePending(input: NewActionConfirmation): Promise<ActionConfirmation>;
  findById(id: string): Promise<ActionConfirmation | undefined>;
  findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<ActionConfirmation | undefined>;
  transition(
    id: string,
    from: ConfirmationStatus,
    to: ConfirmationStatus,
    resolvedAt: Date,
    resolvedBy: string | null,
  ): Promise<ActionConfirmation | undefined>;
  invalidatePending(resolvedAt: Date): Promise<void>;
}

export class DrizzleConfirmationStore implements ConfirmationStore {
  constructor(private readonly db: ShivaDatabase) {}

  async replacePending(
    input: NewActionConfirmation,
  ): Promise<ActionConfirmation> {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${input.conversationId}`}, 0))`,
      );
      await transaction
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
        );
      const [created] = await transaction
        .insert(actionConfirmations)
        .values(input)
        .returning();
      if (!created) throw new Error("The confirmation could not be persisted.");
      return created;
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
  ): Promise<ActionConfirmation | undefined> {
    await this.db
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
      );
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
    return confirmation;
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

  async invalidatePending(resolvedAt: Date): Promise<void> {
    await this.db
      .update(actionConfirmations)
      .set({ status: "DENIED", resolvedAt })
      .where(
        inArray(actionConfirmations.status, ["PENDING", "APPROVED"]),
      );
  }
}

export class InMemoryConfirmationStore implements ConfirmationStore {
  constructor(
    private readonly records: Map<string, ActionConfirmation> = new Map(),
  ) {}

  async replacePending(
    input: NewActionConfirmation,
  ): Promise<ActionConfirmation> {
    for (const [id, record] of this.records) {
      if (
        record.userId === input.userId &&
        record.conversationId === input.conversationId &&
        record.status === "PENDING"
      ) {
        this.records.set(id, {
          ...record,
          status: "DENIED",
          resolvedAt: input.createdAt,
          resolvedBy: input.userId,
        });
      }
    }
    const created: ActionConfirmation = {
      ...input,
      status: "PENDING",
      resolvedAt: null,
      resolvedBy: null,
    };
    this.records.set(created.id, created);
    return { ...created };
  }

  async findById(id: string): Promise<ActionConfirmation | undefined> {
    const confirmation = this.records.get(id);
    return confirmation ? { ...confirmation } : undefined;
  }

  async findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<ActionConfirmation | undefined> {
    const pending = [...this.records.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          (conversationId === undefined ||
            record.conversationId === conversationId) &&
          record.status === "PENDING",
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    if (!pending) return undefined;
    if (pending.expiresAt.getTime() <= now.getTime()) {
      await this.transition(pending.id, "PENDING", "EXPIRED", now, null);
      return undefined;
    }
    return { ...pending };
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

  async invalidatePending(resolvedAt: Date): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.status === "PENDING" || record.status === "APPROVED") {
        this.records.set(id, {
          ...record,
          status: "DENIED",
          resolvedAt,
          resolvedBy: null,
        });
      }
    }
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
  constructor(
    private readonly store: ConfirmationStore,
    private readonly ttlMs: number,
    private readonly createId: () => string = () => randomUUID(),
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) {
      throw new RangeError("Confirmation TTL must be 1000-3600000ms.");
    }
  }

  request(input: {
    readonly agentRunId: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly skill: string;
    readonly arguments: unknown;
    readonly reason: string;
    readonly executionMode: ExecutionMode;
    readonly mutability: ActionMutability;
    readonly impact: ActionImpact;
    readonly settingsRevision: number;
    readonly now: Date;
  }): Promise<ActionConfirmation> {
    return this.store.replacePending({
      id: this.createId(),
      agentRunId: input.agentRunId,
      userId: input.userId,
      conversationId: input.conversationId,
      skill: input.skill,
      sanitizedArguments: sanitizeAuditPayload(input.arguments),
      actionHash: actionFingerprint(input.skill, input.arguments),
      reason: sanitizeAuditText(input.reason, 500),
      executionMode: input.executionMode,
      mutability: input.mutability,
      impact: input.impact,
      settingsRevision: input.settingsRevision,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + this.ttlMs),
    });
  }

  findPending(
    userId: string,
    conversationId: string | undefined,
    now: Date,
  ): Promise<ActionConfirmation | undefined> {
    return this.store.findPending(userId, conversationId, now);
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
      return { outcome: "expired", confirmation: expired ?? confirmation };
    }
    if (!input.approved) {
      const denied = await this.store.transition(
        confirmation.id,
        "PENDING",
        "DENIED",
        input.now,
        input.userId,
      );
      return { outcome: denied ? "denied" : "already_resolved", confirmation };
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
      return { outcome: "mismatch", confirmation: denied ?? confirmation };
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
      : { outcome: "already_resolved", confirmation };
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

  invalidatePending(now: Date): Promise<void> {
    return this.store.invalidatePending(now);
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

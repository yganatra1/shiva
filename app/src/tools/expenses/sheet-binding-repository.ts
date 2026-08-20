import { and, eq, isNull, lt, lte, or } from "drizzle-orm";

import type { ShivaDatabase } from "../../database/pool.js";
import { expenseSheetBindings } from "../../database/schema.js";
import { EXPENSE_SHEET_SCHEMA_VERSION } from "./sheet-binding.js";
import type {
  AttachExpenseSpreadsheetInput,
  ClaimExpenseSheetBindingInput,
  ExpenseSheetBinding,
  ExpenseSheetBindingClaim,
  ExpenseSheetBindingStore,
  MarkExpenseSheetReadyInput,
  ReleaseExpenseSheetClaimInput,
} from "./sheet-binding.js";

const GOOGLE_RESOURCE_ID = /^[A-Za-z0-9_-]{5,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ExpenseSheetBindingPersistenceError extends Error {
  override readonly name = "ExpenseSheetBindingPersistenceError";
}

/** PostgreSQL implementation of the per-user provisioning lease and binding. */
export class DrizzleExpenseSheetBindingStore
  implements ExpenseSheetBindingStore
{
  constructor(private readonly database: ShivaDatabase) {}

  async get(userId: string): Promise<ExpenseSheetBinding | null> {
    assertUuid(userId, "userId");
    const [binding] = await this.database
      .select()
      .from(expenseSheetBindings)
      .where(eq(expenseSheetBindings.userId, userId))
      .limit(1);
    return binding ?? null;
  }

  async claimProvisioning(
    input: ClaimExpenseSheetBindingInput,
  ): Promise<ExpenseSheetBindingClaim> {
    validateClaimInput(input);

    const [inserted] = await this.database
      .insert(expenseSheetBindings)
      .values({
        userId: input.userId,
        ...(input.bootstrapSpreadsheetId
          ? { spreadsheetId: input.bootstrapSpreadsheetId }
          : {}),
        status: "provisioning",
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: expenseSheetBindings.userId })
      .returning();
    if (inserted) return { state: "claimed", binding: inserted };

    const [claimed] = await this.database
      .update(expenseSheetBindings)
      .set({
        status: "provisioning",
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(expenseSheetBindings.userId, input.userId),
          or(
            and(
              eq(expenseSheetBindings.status, "provisioning"),
              or(
                isNull(expenseSheetBindings.leaseOwner),
                lte(expenseSheetBindings.leaseExpiresAt, input.now),
                eq(expenseSheetBindings.leaseOwner, input.leaseOwner),
              ),
            ),
            and(
              eq(expenseSheetBindings.status, "ready"),
              lt(
                expenseSheetBindings.schemaVersion,
                EXPENSE_SHEET_SCHEMA_VERSION,
              ),
            ),
          ),
        ),
      )
      .returning();
    if (claimed) return { state: "claimed", binding: claimed };

    const existing = await this.get(input.userId);
    if (!existing) {
      throw new ExpenseSheetBindingPersistenceError(
        "The expense sheet binding disappeared while its lease was being claimed.",
      );
    }
    return existing.status === "ready"
      ? { state: "ready", binding: existing }
      : { state: "busy", binding: existing };
  }

  async attachSpreadsheetId(
    input: AttachExpenseSpreadsheetInput,
  ): Promise<ExpenseSheetBinding | null> {
    validateMutationInput(input);
    assertSpreadsheetId(input.spreadsheetId);

    const [binding] = await this.database
      .update(expenseSheetBindings)
      .set({
        spreadsheetId: input.spreadsheetId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(expenseSheetBindings.userId, input.userId),
          eq(expenseSheetBindings.status, "provisioning"),
          eq(expenseSheetBindings.leaseOwner, input.leaseOwner),
          or(
            isNull(expenseSheetBindings.spreadsheetId),
            eq(expenseSheetBindings.spreadsheetId, input.spreadsheetId),
          ),
        ),
      )
      .returning();
    return binding ?? null;
  }

  async markReady(
    input: MarkExpenseSheetReadyInput,
  ): Promise<ExpenseSheetBinding | null> {
    validateMutationInput(input);
    assertSpreadsheetId(input.spreadsheetId);
    if (!Number.isInteger(input.sheetId) || input.sheetId < 0) {
      throw new RangeError("sheetId must be a non-negative integer.");
    }
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new RangeError("schemaVersion must be a positive integer.");
    }

    const [binding] = await this.database
      .update(expenseSheetBindings)
      .set({
        status: "ready",
        sheetId: input.sheetId,
        schemaVersion: input.schemaVersion,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(expenseSheetBindings.userId, input.userId),
          eq(expenseSheetBindings.status, "provisioning"),
          eq(expenseSheetBindings.leaseOwner, input.leaseOwner),
          eq(expenseSheetBindings.spreadsheetId, input.spreadsheetId),
        ),
      )
      .returning();
    return binding ?? null;
  }

  async releaseClaim(input: ReleaseExpenseSheetClaimInput): Promise<boolean> {
    validateMutationInput(input);
    const released = await this.database
      .update(expenseSheetBindings)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(expenseSheetBindings.userId, input.userId),
          eq(expenseSheetBindings.status, "provisioning"),
          eq(expenseSheetBindings.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ userId: expenseSheetBindings.userId });
    return released.length === 1;
  }
}

function validateClaimInput(input: ClaimExpenseSheetBindingInput): void {
  validateMutationInput(input);
  assertValidDate(input.leaseExpiresAt, "leaseExpiresAt");
  if (input.leaseExpiresAt.getTime() <= input.now.getTime()) {
    throw new RangeError("leaseExpiresAt must be later than now.");
  }
  if (input.bootstrapSpreadsheetId !== undefined) {
    assertSpreadsheetId(input.bootstrapSpreadsheetId);
  }
}

function validateMutationInput(input: {
  readonly userId: string;
  readonly leaseOwner: string;
  readonly now: Date;
}): void {
  assertUuid(input.userId, "userId");
  assertUuid(input.leaseOwner, "leaseOwner");
  assertValidDate(input.now, "now");
}

function assertSpreadsheetId(value: string): void {
  if (!GOOGLE_RESOURCE_ID.test(value)) {
    throw new TypeError("spreadsheetId must be a valid Google resource ID.");
  }
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) {
    throw new TypeError(`${name} must be a UUID.`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
}

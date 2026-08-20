export const EXPENSE_SHEET_SCHEMA_VERSION = 1;

export type ExpenseSheetBindingStatus = "provisioning" | "ready";

/**
 * Durable metadata for one user's external Google Sheets expense ledger.
 * Expense rows and authentication material are intentionally absent.
 */
export interface ExpenseSheetBinding {
  readonly userId: string;
  readonly spreadsheetId: string | null;
  readonly sheetId: number | null;
  readonly status: ExpenseSheetBindingStatus;
  readonly schemaVersion: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ExpenseSheetBindingClaim =
  | {
      readonly state: "claimed";
      readonly binding: ExpenseSheetBinding;
    }
  | {
      readonly state: "busy";
      readonly binding: ExpenseSheetBinding;
    }
  | {
      readonly state: "ready";
      readonly binding: ExpenseSheetBinding;
    };

export interface ClaimExpenseSheetBindingInput {
  readonly userId: string;
  readonly leaseOwner: string;
  readonly now: Date;
  readonly leaseExpiresAt: Date;
  /** Optional migration path for an already configured spreadsheet. */
  readonly bootstrapSpreadsheetId?: string;
}

export interface AttachExpenseSpreadsheetInput {
  readonly userId: string;
  readonly leaseOwner: string;
  readonly spreadsheetId: string;
  readonly now: Date;
}

export interface MarkExpenseSheetReadyInput
  extends AttachExpenseSpreadsheetInput {
  readonly sheetId: number;
  readonly schemaVersion: number;
}

export interface ReleaseExpenseSheetClaimInput {
  readonly userId: string;
  readonly leaseOwner: string;
  readonly now: Date;
}

/**
 * Compare-and-set persistence boundary used by the sheet provisioner.
 * A null mutation result means the caller no longer owns the provisioning
 * lease (or attempted to attach a conflicting external resource).
 */
export interface ExpenseSheetBindingStore {
  get(userId: string): Promise<ExpenseSheetBinding | null>;
  claimProvisioning(
    input: ClaimExpenseSheetBindingInput,
  ): Promise<ExpenseSheetBindingClaim>;
  attachSpreadsheetId(
    input: AttachExpenseSpreadsheetInput,
  ): Promise<ExpenseSheetBinding | null>;
  markReady(
    input: MarkExpenseSheetReadyInput,
  ): Promise<ExpenseSheetBinding | null>;
  releaseClaim(input: ReleaseExpenseSheetClaimInput): Promise<boolean>;
}

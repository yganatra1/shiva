import { z } from "zod";

export const EXECUTION_MODES = ["SAFE", "AUTO", "FULL_ACCESS"] as const;
export const executionModeSchema = z.enum(EXECUTION_MODES);

export type ExecutionMode = z.infer<typeof executionModeSchema>;

const EXECUTION_MODE_RANK: Readonly<Record<ExecutionMode, number>> = {
  SAFE: 0,
  AUTO: 1,
  FULL_ACCESS: 2,
};

export function compareExecutionModes(
  left: ExecutionMode,
  right: ExecutionMode,
): number {
  return EXECUTION_MODE_RANK[left] - EXECUTION_MODE_RANK[right];
}

export function minExecutionMode(
  left: ExecutionMode,
  right: ExecutionMode,
): ExecutionMode {
  return compareExecutionModes(left, right) <= 0 ? left : right;
}

export function isExecutionModeIncrease(
  current: ExecutionMode,
  requested: ExecutionMode,
): boolean {
  return compareExecutionModes(requested, current) > 0;
}

export const ACTION_MUTABILITIES = ["read", "write"] as const;
export type ActionMutability = (typeof ACTION_MUTABILITIES)[number];

export const ACTION_IMPACTS = ["normal", "sensitive"] as const;
export type ActionImpact = (typeof ACTION_IMPACTS)[number];

export interface ExecutionMetadata {
  readonly mutability: ActionMutability;
  readonly impact: ActionImpact;
  /** A concise deterministic reason shown when this action needs approval. */
  readonly confirmationReason?: string;
}

export interface StoredExecutionState {
  readonly executionMode: ExecutionMode;
  readonly lockdown: boolean;
  /** Monotonic compare-and-set version for concurrent policy decisions. */
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

export interface ExecutionState extends StoredExecutionState {
  readonly maxExecutionMode: ExecutionMode;
  readonly effectiveExecutionMode: ExecutionMode;
}

export function effectiveExecutionMode(
  stored: ExecutionMode,
  configuredMaximum: ExecutionMode,
  lockdown: boolean,
): ExecutionMode {
  if (lockdown) return "SAFE";
  return minExecutionMode(stored, configuredMaximum);
}

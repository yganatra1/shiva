import type { z } from "zod";

import type {
  ActionImpact,
  ActionMutability,
} from "../security/execution-mode.js";

export interface SkillAuditDiagnostic {
  readonly category: string;
  readonly reason: string;
}

export interface SkillContext {
  readonly agentRunId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
  readonly allowedSkills?: readonly string[];
  readonly signal?: AbortSignal;
  /** Runtime-owned policy snapshot used for atomic control transitions. */
  readonly executionStateRevision?: number;
  /** Audit-only details that are never returned as a skill observation. */
  readonly reportAuditDiagnostic?: (
    diagnostic: SkillAuditDiagnostic,
  ) => void;
  now(): Date;
}

export interface SkillFailure {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly confirmation?: {
      readonly id: string;
      readonly skill: string;
      readonly reason: string;
      readonly expiresAt: string;
    };
  };
}

export interface SkillSuccess<TOutput> {
  readonly success: true;
  readonly data: TOutput;
}

export type SkillResult<TOutput> = SkillSuccess<TOutput> | SkillFailure;

export type SkillMutability = ActionMutability;
export type SkillImpact = ActionImpact;

/** Runtime-owned classification used to evaluate a skill before it executes. */
export interface SkillExecutionMetadata {
  readonly mutability: SkillMutability;
  readonly impact: SkillImpact;
  readonly confirmationReason?: string;
  /** Runtime control operations whose classification depends on current state. */
  readonly control?: "execution_mode" | "lockdown";
}

export interface ShivaSkill<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputDescription: string;
  /**
   * Discovery grouping only (see PackRegistry) — never a security boundary.
   * An unscoped planner turn sees pack descriptions instead of every skill;
   * opening a pack reveals the full definitions of the skills inside it.
   */
  readonly pack: string;
  /** Whether the external dependency required by this skill is configured. */
  readonly configured?: boolean;
  readonly inputSchema: z.ZodType<TInput>;
  /** Baseline classification shown in the catalog. */
  readonly execution: SkillExecutionMetadata;
  /**
   * Optional runtime classifier for actions whose mutability depends on
   * validated input or current provider state. It may only classify; it must
   * not perform the external action itself.
   */
  classifyExecution?(
    input: TInput,
    context: SkillContext,
  ): SkillExecutionMetadata | Promise<SkillExecutionMetadata>;
  execute(
    input: TInput,
    context: SkillContext,
  ): Promise<SkillResult<TOutput>>;
}

/** Type-erased registry entry used by the model-independent executor. */
export interface RegisteredSkill {
  readonly name: string;
  readonly description: string;
  readonly inputDescription: string;
  readonly pack: string;
  readonly configured: boolean;
  readonly inputSchema: z.ZodType<unknown>;
  readonly execution: SkillExecutionMetadata;
  readonly classifyExecution?: (
    input: unknown,
    context: SkillContext,
  ) => Promise<SkillExecutionMetadata>;
  execute(
    input: unknown,
    context: SkillContext,
  ): Promise<SkillResult<unknown>>;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly inputDescription: string;
  readonly pack: string;
  readonly configured: boolean;
  readonly execution: SkillExecutionMetadata;
}

/** Level-1 catalog entry — a pack's own metadata plus its skill count. */
export interface PackSummary {
  readonly name: string;
  readonly description: string;
  readonly skillCount: number;
  /** True when at least one skill in the pack has a configured integration. */
  readonly configured: boolean;
}

import type { z } from "zod";

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
  };
}

export interface SkillSuccess<TOutput> {
  readonly success: true;
  readonly data: TOutput;
}

export type SkillResult<TOutput> = SkillSuccess<TOutput> | SkillFailure;

export interface ShivaSkill<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputDescription: string;
  /** Whether the external dependency required by this skill is configured. */
  readonly configured?: boolean;
  readonly inputSchema: z.ZodType<TInput>;
  readonly permissions: readonly string[];
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
  readonly configured: boolean;
  readonly inputSchema: z.ZodType<unknown>;
  readonly permissions: readonly string[];
  execute(
    input: unknown,
    context: SkillContext,
  ): Promise<SkillResult<unknown>>;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly inputDescription: string;
  readonly configured: boolean;
  readonly permissions: readonly string[];
}

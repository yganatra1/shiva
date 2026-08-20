import type { z } from "zod";

export interface SkillContext {
  readonly agentRunId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
  readonly allowedSkills?: readonly string[];
  readonly signal?: AbortSignal;
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
  readonly permissions: readonly string[];
}

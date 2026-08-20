import { and, eq } from "drizzle-orm";

import type { ShivaDatabase } from "../database/pool.js";
import { agentRuns, skillRuns } from "../database/schema.js";

export const REDACTED_EXPENSE_AGENT_REQUEST = "[expense request redacted]";
export const REDACTED_EXPENSE_SKILL_PAYLOAD = Object.freeze({
  redacted: true,
});

export function isExpenseAuditSkill(skill: string): boolean {
  return skill === "record_expense" || skill === "expense_report";
}

export type AgentRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "max_steps";
export type SkillRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

export interface StartAgentRunInput {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly request: string;
  readonly startedAt: Date;
}

export interface FinishAgentRunInput {
  readonly id: string;
  readonly status: Exclude<AgentRunStatus, "running">;
  readonly stepCount: number;
  readonly errorCode: string | null;
  readonly finishedAt: Date;
  readonly durationMs: number;
}

export interface StartSkillRunInput {
  readonly id: string;
  readonly agentRunId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly skill: string;
  readonly input: unknown;
  readonly permissions: readonly string[];
  readonly startedAt: Date;
}

export interface FinishSkillRunInput {
  readonly id: string;
  readonly status: Exclude<SkillRunStatus, "running">;
  readonly result: unknown;
  readonly errorCode: string | null;
  readonly finishedAt: Date;
  readonly durationMs: number;
}

export interface AgentAuditPort {
  startAgentRun(input: StartAgentRunInput): Promise<void>;
  finishAgentRun(input: FinishAgentRunInput): Promise<void>;
  startSkillRun(input: StartSkillRunInput): Promise<void>;
  finishSkillRun(input: FinishSkillRunInput): Promise<void>;
}

export const NOOP_AGENT_AUDIT: AgentAuditPort = {
  async startAgentRun() {},
  async finishAgentRun() {},
  async startSkillRun() {},
  async finishSkillRun() {},
};

export class AgentAuditRepository implements AgentAuditPort {
  constructor(private readonly db: ShivaDatabase) {}

  async startAgentRun(input: StartAgentRunInput): Promise<void> {
    await this.db.insert(agentRuns).values({
      id: input.id,
      userId: input.userId,
      conversationId: input.conversationId,
      request: input.request,
      startedAt: input.startedAt,
      metadata: {},
    });
  }

  async finishAgentRun(input: FinishAgentRunInput): Promise<void> {
    const updated = await this.db
      .update(agentRuns)
      .set({
        status: input.status,
        stepCount: input.stepCount,
        errorCode: input.errorCode,
        finishedAt: input.finishedAt,
        durationMs: normalizedDuration(input.durationMs),
      })
      .where(and(eq(agentRuns.id, input.id), eq(agentRuns.status, "running")))
      .returning({ id: agentRuns.id });
    if (updated.length !== 1) {
      throw new Error("The active agent audit run could not be finalized.");
    }
  }

  async startSkillRun(input: StartSkillRunInput): Promise<void> {
    await this.db.insert(skillRuns).values({
      id: input.id,
      agentRunId: input.agentRunId,
      userId: input.userId,
      conversationId: input.conversationId,
      skill: input.skill,
      input: input.input,
      permissions: [...input.permissions],
      startedAt: input.startedAt,
    });
  }

  async finishSkillRun(input: FinishSkillRunInput): Promise<void> {
    const updated = await this.db
      .update(skillRuns)
      .set({
        status: input.status,
        result: input.result,
        errorCode: input.errorCode,
        finishedAt: input.finishedAt,
        durationMs: normalizedDuration(input.durationMs),
      })
      .where(and(eq(skillRuns.id, input.id), eq(skillRuns.status, "running")))
      .returning({ id: skillRuns.id });
    if (updated.length !== 1) {
      throw new Error("The active skill audit run could not be finalized.");
    }
  }
}

function normalizedDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

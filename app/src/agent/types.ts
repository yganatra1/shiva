import type { ChatMessage } from "../brain/ai-provider.js";
import type { SkillResult, SkillSummary } from "../skills/types.js";

export type AgentDecision =
  | {
      readonly type: "respond";
      readonly outcome: "success" | "failure";
      readonly message: string;
    }
  | {
      readonly type: "skill_call";
      readonly skill: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };

export interface AgentObservation {
  readonly step: number;
  readonly skill: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: SkillResult<unknown>;
}

export interface AgentRequest {
  readonly userMessage: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
  readonly contextMessages: readonly ChatMessage[];
  readonly allowedSkills?: readonly string[];
  readonly requiredSkills?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AgentPlanningContext {
  readonly request: AgentRequest;
  readonly skills: readonly SkillSummary[];
  readonly observations: readonly AgentObservation[];
  readonly step: number;
  readonly maxSteps: number;
  readonly now: Date;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly response: string;
  readonly steps: number;
  readonly observations: readonly AgentObservation[];
}

export interface AgentPlanner {
  decide(context: AgentPlanningContext): Promise<AgentDecision>;
}

export interface AgentOrchestratorPort {
  shouldHandle(message: string): boolean;
  run(request: AgentRequest): Promise<AgentRunResult>;
}

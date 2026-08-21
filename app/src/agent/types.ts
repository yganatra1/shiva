import type { ChatMessage } from "../brain/ai-provider.js";
import type { SkillResult, SkillSummary } from "../skills/types.js";

export type AgentDecision =
  | {
      readonly type: "direct_chat";
    }
  | {
      readonly type: "describe_capabilities";
    }
  | {
      readonly type: "clarify";
      readonly message: string;
    }
  | {
      readonly type: "respond";
      readonly outcome: "success" | "failure";
      readonly message: string;
    }
  | {
      readonly type: "skill_call";
      readonly skill: string;
      /** Immutable request scope selected from the original user task. */
      readonly selectedSkills: readonly string[];
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
  readonly signal?: AbortSignal;
}

export interface AgentPlanningContext {
  readonly request: AgentRequest;
  readonly skills: readonly SkillSummary[];
  readonly observations: readonly AgentObservation[];
  readonly step: number;
  readonly maxSteps: number;
  readonly now: Date;
  readonly plannerFeedback?: string;
}

export type AgentRunResult =
  | {
      readonly kind: "response";
      readonly runId: string;
      readonly response: string;
      readonly steps: number;
      readonly observations: readonly AgentObservation[];
    }
  | {
      readonly kind: "direct_chat";
      readonly runId: string;
      readonly response: undefined;
      readonly steps: number;
      readonly observations: readonly AgentObservation[];
      readonly plannerFallback?: "INVALID_OUTPUT" | "INVALID_SCOPE";
    };

export interface AgentPlanner {
  decide(context: AgentPlanningContext): Promise<AgentDecision>;
}

export interface AgentOrchestratorPort {
  run(request: AgentRequest): Promise<AgentRunResult>;
}

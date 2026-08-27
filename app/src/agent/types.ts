import type { ChatMessage } from "../brain/ai-provider";
import type { RequestTrigger } from "../core/request-trigger";
import type { SkillResult, SkillSummary } from "../skills/types";

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
      readonly message: string;
    }
  | {
      readonly type: "skill_call";
      readonly skill: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      /** Planner interpretation only; runtime metadata remains authoritative. */
      readonly authorization?: "user_authorized" | "unrequested" | undefined;
    }
  | {
      readonly type: "approve_confirmation";
      readonly confirmationId: string;
      readonly skill: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "deny_confirmation";
      readonly confirmationId: string;
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
  /**
   * Pre-formatted embedding-retrieved memory relevant to this turn's message
   * (see MemoryRetriever), included on every planner decision so the planner
   * always has the user's stored context without needing to call
   * memory_search itself first.
   */
  readonly relevantMemoryContext?: string;
  /** Base64 images attached to this chat turn (no data: URI prefix). */
  readonly images?: readonly string[];
  readonly allowedSkills?: readonly string[];
  /**
   * Database id of the authoritative user message. Present on real chat turns
   * and used when a delegation becomes a durable asynchronous request.
   */
  readonly sourceMessageId?: string;
  /** Runtime-verified provenance; never accepted from planner arguments. */
  readonly trigger?: RequestTrigger;
  /**
   * Present only while Core is resuming a delegated request. These are plain
   * text facts for the planner, not a serialized workflow or state machine.
   */
  readonly delegationContinuation?: {
    readonly requestId: string;
    readonly responseId: string;
    readonly originalUserRequest: string;
    readonly executionContext: string;
    readonly latestAgentResponse: string;
  };
  readonly signal?: AbortSignal;
}

export interface AgentPlanningContext {
  readonly request: AgentRequest;
  /** Every skill this run may call — the full registry, or the request's fixed scope. */
  readonly skills: readonly SkillSummary[];
  readonly observations: readonly AgentObservation[];
  readonly step: number;
  readonly maxSteps: number;
  readonly now: Date;
  readonly plannerFeedback?: string;
  readonly pendingConfirmation?: {
    readonly id: string;
    readonly skill: string;
    readonly sanitizedArguments: unknown;
    readonly reason: string;
    readonly expiresAt: string;
    readonly mutability: "read" | "write";
    readonly impact: "normal" | "sensitive";
  };
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
    }
  | {
      /** Core has durably queued work and is returning a short acknowledgement. */
      readonly kind: "delegated";
      readonly runId: string;
      readonly response: string;
      readonly orchestrationRequestId: string;
      readonly taskId: string;
      readonly steps: number;
      readonly observations: readonly AgentObservation[];
    };

export interface AgentPlanner {
  decide(context: AgentPlanningContext): Promise<AgentDecision>;
}

export interface AgentOrchestratorPort {
  run(request: AgentRequest): Promise<AgentRunResult>;
}

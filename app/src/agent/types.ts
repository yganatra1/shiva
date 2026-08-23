import type { ChatMessage } from "../brain/ai-provider";
import type { PackSummary, SkillResult, SkillSummary } from "../skills/types";

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
      /**
       * Prompting-only narrowing step, never a security boundary: reveals the
       * full definitions of the skills inside one or more packs without yet
       * committing to a specific skill_call. Additive across repeated calls
       * (see agent-loop.ts); only valid before the run's skill scope freezes.
       */
      readonly type: "open_packs";
      readonly packs: readonly string[];
    }
  | {
      readonly type: "respond";
      readonly message: string;
    }
  | {
      readonly type: "skill_call";
      readonly skill: string;
      /** Skills the current plan relies on; pack scope remains authoritative. */
      readonly selectedSkills: readonly string[];
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
  /** Base64 images attached to this chat turn (no data: URI prefix). */
  readonly images?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AgentPlanningContext {
  readonly request: AgentRequest;
  /**
   * Complete pack catalog (Level 1), always present regardless of scope
   * state. Cheap enough (~15-25 short entries) to show on every planner call
   * so the model never has to guess at a pack it can't see.
   */
  readonly packs: readonly PackSummary[];
  /** Packs already opened this run via open_packs, for the prompt display only. */
  readonly openPacks: readonly string[];
  /**
   * Full skill definitions (Level 2/3): empty until at least one pack is
   * opened or the scope is frozen, then narrowed to the opened packs' or
   * frozen scope's skills — never the complete registry on an unscoped turn.
   */
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
    };

export interface AgentPlanner {
  decide(context: AgentPlanningContext): Promise<AgentDecision>;
}

export interface AgentOrchestratorPort {
  run(request: AgentRequest): Promise<AgentRunResult>;
}

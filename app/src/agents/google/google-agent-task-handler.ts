import type { AgentOrchestratorPort } from "../../agent/types";
import type { AgentTaskHandler } from "../shared/agent-worker";

export interface GoogleAgentTaskHandlerOptions {
  readonly loop: AgentOrchestratorPort;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
  readonly allowedSkills: readonly string[];
}

/**
 * Adapts one minimal Redis task to Google Agent's isolated planner/skill loop.
 * The worker sees only Core's natural-language instruction and correlation
 * identifiers; it receives no Core conversation history or memory.
 */
export function createGoogleAgentTaskHandler(
  options: GoogleAgentTaskHandlerOptions,
): AgentTaskHandler {
  return async (task, context) => {
    const result = await options.loop.run({
      userMessage: task.instruction,
      conversationId: task.conversationId,
      userId: options.userId,
      userName: options.userName,
      timeZone: options.timeZone,
      contextMessages: [],
      allowedSkills: options.allowedSkills,
      signal: context.signal,
    });

    if (result.kind === "response") return result.response;
    return "Google Agent could not select a configured Google operation for this task, so it made no change.";
  };
}

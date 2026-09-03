import type { AgentOrchestratorPort } from "../../agent/types";
import type { AgentTaskHandler } from "../shared/agent-worker";

export interface FinanceManagerAgentTaskHandlerOptions {
  readonly loop: AgentOrchestratorPort;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
}

/**
 * Adapts one minimal Redis task to Finance Manager's isolated planner/skill
 * loop. The worker sees only Core's natural-language instruction; Core keeps
 * the conversation and must not fetch MFapi data or calculate metrics itself.
 */
export function createFinanceManagerAgentTaskHandler(
  options: FinanceManagerAgentTaskHandlerOptions,
): AgentTaskHandler {
  return async (task, context) => {
    const result = await options.loop.run({
      userMessage: task.instruction,
      conversationId: task.conversationId,
      userId: options.userId,
      userName: options.userName,
      timeZone: options.timeZone,
      contextMessages: [],
      signal: context.signal,
    });

    if (result.kind === "response") return result.response;
    return "Finance Manager could not complete this mutual-fund research task from the available NAV data.";
  };
}

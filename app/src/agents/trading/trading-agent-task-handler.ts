import type { AgentOrchestratorPort } from "../../agent/types";
import type { AgentTaskHandler } from "../shared/agent-worker";

export interface TradingAgentTaskHandlerOptions {
  readonly loop: AgentOrchestratorPort;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
}

/**
 * Adapts one minimal Redis task to Trading Agent's isolated planner/skill
 * loop. The worker sees only Core's natural-language instruction and
 * correlation identifiers; it receives no Core conversation history or
 * memory.
 */
export function createTradingAgentTaskHandler(
  options: TradingAgentTaskHandlerOptions,
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
    return "Trading Agent could not select a configured trading operation for this task, so it made no change.";
  };
}

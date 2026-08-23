import { z } from "zod";

import {
  AgentDelegationError,
  type AgentClient,
} from "../../agents/agent-client";
import type { AgentRegistry } from "../../agents/agent-registry";
import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";

export interface DelegateToAgentOutput {
  readonly summary: string;
  readonly steps?: number;
}

/** Maps a thrown AgentDelegationError to a skill failure code/message; rethrows anything else. */
function agentErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof AgentDelegationError)) throw error;
  switch (error.failure) {
    case "AGENT_NOT_FOUND":
      return { code: "AGENT_NOT_FOUND", message: error.message };
    case "AGENT_TIMEOUT":
      return {
        code: "AGENT_TIMEOUT",
        message: "The agent did not finish this goal in time.",
      };
    case "AGENT_UNREACHABLE":
      return {
        code: "AGENT_UNREACHABLE",
        message: "The agent process is not reachable right now.",
      };
    default:
      return {
        code: "AGENT_DELEGATION_FAILED",
        message: error.message,
      };
  }
}

export function createDelegateToAgentSkill(
  agentClient: Pick<AgentClient, "delegate">,
  agentRegistry: AgentRegistry,
) {
  const agents = agentRegistry.list();
  const agentNames = agents.map((agent) => agent.name);
  const catalog = agents
    .map((agent) => `  - "${agent.name}": ${agent.description}`)
    .join("\n");

  const inputSchema = z
    .object({
      agent:
        agentNames.length > 0
          ? z.enum(agentNames as [string, ...string[]])
          : z.string(),
      goal: z.string().trim().min(1).max(2_000),
    })
    .strict();

  return defineSkill<z.infer<typeof inputSchema>, DelegateToAgentOutput>({
    name: "delegate_to_agent",
    description:
      `Hands off a self-contained goal to one of Shiva's autonomous background agents and returns its result. Each agent has its own reasoning loop and tools — it figures out the steps itself; you only give it the goal. Available agents:\n${catalog || "  (none registered)"}\nUse this instead of a direct device_* skill when the request needs multiple exploratory steps (e.g. finding and tapping through an app's UI) rather than one well-defined action.`,
    inputDescription: `{ "agent": ${agentNames.map((name) => `"${name}"`).join(" | ") || "string"}, "goal": string (a complete, self-contained description of what the agent should accomplish) }`,
    pack: "agents",
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason:
        "This delegates a goal to an autonomous agent that can take real actions (tapping through apps, placing calls, etc.) without further confirmation on each individual step.",
    },
    configured: agentNames.length > 0,
    async execute(input, context: SkillContext): Promise<SkillResult<DelegateToAgentOutput>> {
      if (agentNames.length === 0) {
        return {
          success: false,
          error: {
            code: "AGENT_UNAVAILABLE",
            message: "No autonomous agents are registered.",
          },
        };
      }
      try {
        const result = await agentClient.delegate(input.agent, input.goal, {
          ...(context.signal ? { signal: context.signal } : {}),
        });
        if (!result.success) {
          return {
            success: false,
            error: { code: "AGENT_GOAL_FAILED", message: result.summary },
          };
        }
        return {
          success: true,
          data: {
            summary: result.summary,
            ...(result.steps !== undefined ? { steps: result.steps } : {}),
          },
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: agentErrorToFailure(error) };
      }
    },
  });
}

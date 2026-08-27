import { z } from "zod";

import {
  AgentDelegationError,
  type DelegateOptions,
} from "../../agents/agent-client";
import type { AgentRegistry } from "../../agents/agent-registry";
import type { AgentDelegationResult } from "../../agents/types";
import { defineSkill } from "../define-skill";
import type { SkillContext } from "../types";

export interface QueuedAgentDelegation {
  readonly queued: true;
  readonly requestId: string;
  readonly taskId: string;
  readonly userMessage: string;
}

export interface DelegationContext {
  readonly agentRunId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly sourceMessageId?: string;
  readonly originalUserRequest?: string;
  readonly executionContext?: string;
  readonly userMessage?: string;
  readonly orchestrationRequestId?: string;
  readonly agentResponseId?: string;
  readonly now: Date;
}

export interface AgentDelegator {
  delegate(
    agentId: string,
    instruction: string,
    options?: DelegateOptions & { readonly orchestration?: DelegationContext },
  ): Promise<AgentDelegationResult | QueuedAgentDelegation>;
}

export type DelegateToAgentOutput =
  | QueuedAgentDelegation
  | {
      /** Migration-only result from the former synchronous HTTP client. */
      readonly summary: string;
      readonly steps?: number;
    };

/** Maps transport/delegation errors to a grounded skill failure. */
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
        message: "The agent did not finish this task in time.",
      };
    case "AGENT_UNREACHABLE":
      return {
        code: "AGENT_UNREACHABLE",
        message: "The agent process is not reachable right now.",
      };
    case "AGENT_OFFLINE":
      return {
        code: "AGENT_OFFLINE",
        message: error.message,
      };
    case "TRANSPORT_UNAVAILABLE":
      return {
        code: "AGENT_TRANSPORT_UNAVAILABLE",
        message: "The internal agent queue is unavailable right now.",
      };
    case "DELEGATION_LIMIT_REACHED":
      return { code: "DELEGATION_LIMIT_REACHED", message: error.message };
    default:
      return { code: "AGENT_DELEGATION_FAILED", message: error.message };
  }
}

export function createDelegateToAgentSkill(
  delegator: AgentDelegator,
  agentRegistry: AgentRegistry,
) {
  const agents = agentRegistry.list();
  const agentIds = agents.map((agent) => agent.id);
  const catalog = agents
    .map((agent) => {
      const capabilities = agent.capabilities
        .map((capability) => `      - ${capability}`)
        .join("\n");
      return `  - "${agent.id}" (${agent.name}): ${agent.description}${capabilities ? `\n    Capabilities:\n${capabilities}` : ""}`;
    })
    .join("\n");
  const hasDeviceAgent = agents.some(
    (agent) => agent.id === "device" || agent.id === "device-agent",
  );

  const inputSchema = z
    .object({
      agent:
        agentIds.length > 0
          ? z.enum(agentIds as [string, ...string[]])
          : z.string(),
      instruction: z.string().trim().min(1).max(4_000).optional(),
      /** @deprecated Accepted only while old callers migrate to instruction. */
      goal: z.string().trim().min(1).max(4_000).optional(),
      executionContext: z.string().trim().min(1).max(8_000).optional(),
      userMessage: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict()
    .refine((input) => Boolean(input.instruction ?? input.goal), {
      message: "instruction is required",
      path: ["instruction"],
    });

  return defineSkill<z.infer<typeof inputSchema>, DelegateToAgentOutput>({
    name: "delegate_to_agent",
    description:
      `Durably queues one minimal natural-language instruction for a specialized agent process. The agent replies later in plain text; Shiva Core keeps the conversation and uses its saved natural-language execution context to decide what happens next. Available agents:\n${catalog || "  (none registered)"}\nResolve personal memory, people/contact details, permissions, and cross-agent coordination in Core. Send the chosen agent only the details its narrow task requires.${hasDeviceAgent ? " Every Android-phone task, including single-step contact searches, belongs to the registered device agent." : ""}`,
    inputDescription:
      `{ "agent": ${agentIds.map((id) => `"${id}"`).join(" | ") || "string"}, "instruction": string (minimal self-contained task for that agent), "executionContext": string (required on the first delegation: a short natural-language account of the full original request and contingencies; never a flow array or status syntax), "userMessage": string (short acknowledgement to show the user while the task runs) }`,
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason:
        "This delegates a goal to an autonomous agent that can take real actions (placing calls, sending messages, opening apps, etc.) without further confirmation on each individual step.",
    },
    classifyExecution(_input, context) {
      // The first delegation is always a sensitive boundary: its exact
      // arguments include the prose execution context that describes the full
      // compound objective and contingencies. Once that exact delegation has
      // been approved and durably created, Core alone supplies these two
      // correlation ids while reasoning over an agent response. A follow-on
      // instruction inside that already-approved objective is therefore an
      // ordinary write, not a second autonomous-goal confirmation. Lockdown,
      // Safe mode, and the planner's user-authorized flag still apply normally.
      return (context.orchestrationRequestId && context.agentResponseId) ||
        context.trigger?.source === "scheduled_task"
        ? { mutability: "write", impact: "normal" }
        : {
            mutability: "write",
            impact: "sensitive",
            confirmationReason:
              "This delegates a goal to an autonomous agent that can take real actions (placing calls, sending messages, opening apps, etc.) without further confirmation on each individual step.",
          };
    },
    configured: agentIds.length > 0,
    async execute(input, context: SkillContext) {
      if (agentIds.length === 0) {
        return {
          success: false,
          error: {
            code: "AGENT_UNAVAILABLE",
            message: "No autonomous agents are registered.",
          },
        };
      }
      const instruction = input.instruction ?? input.goal;
      if (!instruction) {
        return {
          success: false,
          error: {
            code: "AGENT_INSTRUCTION_REQUIRED",
            message: "The delegated agent instruction is missing.",
          },
        };
      }
      if (
        input.instruction &&
        !context.orchestrationRequestId &&
        !input.executionContext
      ) {
        return {
          success: false,
          error: {
            code: "EXECUTION_CONTEXT_REQUIRED",
            message:
              "Core must create a short natural-language execution context before the first agent delegation.",
          },
        };
      }
      try {
        const result = await delegator.delegate(input.agent, instruction, {
          ...(context.signal ? { signal: context.signal } : {}),
          orchestration: {
            agentRunId: context.agentRunId,
            conversationId: context.conversationId,
            userId: context.userId,
            ...(context.sourceMessageId
              ? { sourceMessageId: context.sourceMessageId }
              : {}),
            ...(context.originalUserRequest
              ? { originalUserRequest: context.originalUserRequest }
              : {}),
            ...(input.executionContext
              ? { executionContext: input.executionContext }
              : {}),
            ...(input.userMessage ? { userMessage: input.userMessage } : {}),
            ...(context.orchestrationRequestId
              ? { orchestrationRequestId: context.orchestrationRequestId }
              : {}),
            ...(context.agentResponseId
              ? { agentResponseId: context.agentResponseId }
              : {}),
            now: context.now(),
          },
        });
        if ("queued" in result) {
          return { success: true, data: result };
        }
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

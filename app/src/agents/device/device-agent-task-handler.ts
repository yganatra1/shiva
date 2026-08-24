import type { DeviceAgentConfig } from "../../config/environment";
import type { AgentTaskHandler } from "../shared/agent-worker";
import { runDeviceAgentGoal } from "./device-agent-loop";
import type { DeviceAgentPlanner } from "./device-agent-types";
import type { DeviceCommandDispatcher } from "./device-command-dispatcher";

export interface DeviceAgentTaskHandlerOptions {
  readonly dispatcher: DeviceCommandDispatcher;
  readonly planner: DeviceAgentPlanner;
  readonly maxSteps: number;
  readonly mockCallOutcome?: DeviceAgentConfig["deviceAgentMockCallOutcome"];
}

/**
 * Creates the Redis worker boundary independently of process startup, which
 * keeps the explicit POC simulation testable without a Redis server or phone.
 */
export function createDeviceAgentTaskHandler(
  options: DeviceAgentTaskHandlerOptions,
): AgentTaskHandler {
  return async (task, context) => {
    if (options.mockCallOutcome) {
      return mockCallResponse(task.instruction, options.mockCallOutcome);
    }
    if (!options.dispatcher.isConnected()) {
      return "Device Agent could not attempt the task because no phone is connected.";
    }
    const result = await runDeviceAgentGoal(
      task.instruction,
      options.dispatcher,
      options.planner,
      {
        maxSteps: options.maxSteps,
        signal: context.signal,
      },
    );
    return {
      message: result.summary,
      metadata: { toolCalls: result.steps },
    };
  };
}

function mockCallResponse(
  instruction: string,
  outcome: NonNullable<DeviceAgentConfig["deviceAgentMockCallOutcome"]>,
) {
  if (!/\bcall\b/i.test(instruction)) {
    return {
      message:
        "Device Agent mock mode supports only delegated phone-call instructions, so it made no change.",
      metadata: { mock: true, simulatedCapability: "phone_call" },
    };
  }
  const target = mockCallTarget(instruction);
  return {
    message:
      outcome === "answered"
        ? `${target} answered the call.`
        : `${target} did not answer the call.`,
    metadata: {
      mock: true,
      simulatedCapability: "phone_call",
    },
  };
}

function mockCallTarget(instruction: string): string {
  const match = instruction.match(
    /\bcall\s+(.+?)(?=\s+at\s+(?:(?:phone\s+)?(?:number\s+)?[+(\d])|\s+(?:and|then)\s+|[.!?](?:\s|$)|$)/i,
  );
  const candidate = match?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .slice(0, 100);
  if (!candidate || /^[+(\d\s)-]+$/.test(candidate)) return "The recipient";
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

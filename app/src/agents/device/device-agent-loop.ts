import {
  DeviceDispatchError,
  type DeviceCommandDispatcher,
} from "./device-command-dispatcher";
import { DEVICE_TOOLS } from "./device-tools";
import { DeviceAgentPlannerError } from "./device-agent-planner";
import type {
  DeviceAgentGoalResult,
  DeviceAgentPlanner,
  DeviceAgentStep,
} from "./device-agent-types";

export const DEFAULT_DEVICE_AGENT_MAX_STEPS = 15;
const MAX_DEVICE_AGENT_MAX_STEPS = 32;
const TOOL_CALL_TIMEOUT_MS = 20_000;

const KNOWN_TOOL_NAMES = new Set(DEVICE_TOOLS.map((tool) => tool.name));

export interface DeviceAgentLoopOptions {
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs one delegated goal to completion: plan a tool call, execute it against
 * the phone, feed the real result back to the planner, repeat. Deliberately
 * not AgentLoop (app/src/agent/agent-loop.ts) — this is a one-shot delegated
 * goal with no packs, confirmations, or audit, not an interactive chat turn.
 */
export async function runDeviceAgentGoal(
  goal: string,
  dispatcher: Pick<DeviceCommandDispatcher, "dispatch">,
  planner: DeviceAgentPlanner,
  options: DeviceAgentLoopOptions = {},
): Promise<DeviceAgentGoalResult> {
  const maxSteps = clampMaxSteps(options.maxSteps);
  const steps: DeviceAgentStep[] = [];
  let correctionRequired: string | undefined;

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber += 1) {
    options.signal?.throwIfAborted();

    let decision;
    try {
      decision = await planner.decide({
        goal,
        steps,
        stepNumber,
        maxSteps,
        ...(correctionRequired ? { correctionRequired } : {}),
      });
    } catch (error: unknown) {
      if (!(error instanceof DeviceAgentPlannerError)) throw error;
      return {
        success: false,
        summary: "The device agent could not produce a valid plan for this goal.",
        steps: steps.length,
      };
    }
    correctionRequired = undefined;

    if (decision.type === "done") {
      return { success: decision.success, summary: decision.summary, steps: steps.length };
    }

    if (!KNOWN_TOOL_NAMES.has(decision.tool)) {
      correctionRequired = `'${decision.tool}' is not a registered tool. Choose one of: ${[...KNOWN_TOOL_NAMES].join(", ")}.`;
      continue;
    }

    options.signal?.throwIfAborted();
    try {
      const result = await dispatcher.dispatch(decision.tool, decision.arguments, {
        timeoutMs: TOOL_CALL_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      steps.push({ step: stepNumber, tool: decision.tool, arguments: decision.arguments, result });
    } catch (error: unknown) {
      if (!(error instanceof DeviceDispatchError)) throw error;
      // Surfaced as a synthetic failed step rather than aborting the goal —
      // a dispatch-level failure (timeout, momentary disconnect) is exactly
      // the kind of thing the planner should see and react to, the same way
      // it reacts to a real FAILED result from the phone.
      steps.push({
        step: stepNumber,
        tool: decision.tool,
        arguments: decision.arguments,
        result: { commandId: "dispatch-error", status: "FAILED", error: error.message },
      });
    }
  }

  return {
    success: false,
    summary: `The device agent reached its ${maxSteps}-step limit before finishing this goal.`,
    steps: steps.length,
  };
}

function clampMaxSteps(maxSteps: number | undefined): number {
  if (maxSteps === undefined) return DEFAULT_DEVICE_AGENT_MAX_STEPS;
  return Math.min(MAX_DEVICE_AGENT_MAX_STEPS, Math.max(1, Math.trunc(maxSteps)));
}

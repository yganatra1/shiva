import type { SkillExecutionMetadata } from "../skills/types";
import {
  compareExecutionModes,
  executionModeSchema,
  isExecutionModeIncrease,
  type ExecutionMode,
  type ExecutionState,
} from "./execution-mode";
import { ExecutionStateService } from "./execution-state";
import { InMemoryExecutionStateStore } from "./execution-state";

export interface ExecutionPolicyRequest {
  readonly skill: string;
  readonly arguments: unknown;
  readonly execution: SkillExecutionMetadata;
  readonly userAuthorized: boolean;
  readonly confirmed: boolean;
}

export interface ExecutionPolicyDecision {
  readonly action: "execute" | "confirm" | "deny";
  readonly state: ExecutionState;
  readonly execution: SkillExecutionMetadata;
  readonly code?: string;
  readonly message?: string;
  readonly confirmationReason?: string;
}

/** Deterministic, model-neutral policy for every registered skill invocation. */
export class ExecutionPolicyEngine {
  constructor(
    private readonly state: ExecutionStateService = new ExecutionStateService(
      new InMemoryExecutionStateStore(),
      "FULL_ACCESS",
    ),
  ) {}

  getState(): Promise<ExecutionState> {
    return this.state.getState();
  }

  async evaluate(
    request: ExecutionPolicyRequest,
  ): Promise<ExecutionPolicyDecision> {
    const state = await this.state.getState();
    if (request.execution.control === "execution_mode") {
      return this.evaluateExecutionModeChange(request, state);
    }
    if (request.execution.control === "lockdown") {
      return this.evaluateLockdownChange(request, state);
    }

    if (request.execution.mutability === "write" && state.lockdown) {
      return deny(
        state,
        request.execution,
        "LOCKDOWN_ACTIVE",
        "Lockdown is active. State-changing actions are blocked.",
      );
    }
    if (request.execution.impact === "sensitive") {
      if (state.effectiveExecutionMode === "FULL_ACCESS") {
        return execute(state, request.execution);
      }
      return request.confirmed
        ? execute(state, request.execution)
        : confirm(
            state,
            request.execution,
            request.execution.confirmationReason ??
              "This is a sensitive or destructive action.",
          );
    }
    if (request.execution.mutability === "read") {
      return execute(state, request.execution);
    }
    if (state.effectiveExecutionMode === "SAFE") {
      return request.confirmed
        ? execute(state, request.execution)
        : confirm(
            state,
            request.execution,
            "Safe mode requires confirmation before this state-changing action.",
          );
    }
    if (!request.userAuthorized) {
      return request.confirmed
        ? execute(state, request.execution)
        : confirm(
            state,
            request.execution,
            "This state-changing action was not clearly authorized by the user's request.",
          );
    }
    return execute(state, request.execution);
  }

  private evaluateExecutionModeChange(
    request: ExecutionPolicyRequest,
    state: ExecutionState,
  ): ExecutionPolicyDecision {
    const requested = executionModeFromArguments(request.arguments);
    if (!requested) {
      return deny(
        state,
        request.execution,
        "INVALID_SKILL_INPUT",
        "The requested execution mode is invalid.",
      );
    }
    if (compareExecutionModes(requested, state.maxExecutionMode) > 0) {
      return deny(
        state,
        request.execution,
        "EXECUTION_MODE_EXCEEDS_MAX",
        `${modeLabel(requested)} is disabled by the host configuration. Maximum available mode is ${modeLabel(state.maxExecutionMode)}.`,
      );
    }
    if (state.lockdown && requested !== "SAFE") {
      return deny(
        state,
        request.execution,
        "LOCKDOWN_ACTIVE",
        "Lockdown must be disabled before increasing execution authority.",
      );
    }
    const increasing = isExecutionModeIncrease(
      state.effectiveExecutionMode,
      requested,
    );
    const classified = {
      ...request.execution,
      impact: increasing ? ("sensitive" as const) : ("normal" as const),
    };
    if (!request.userAuthorized && !request.confirmed) {
      return confirm(
        state,
        classified,
        "This execution-mode change was not clearly requested by the user.",
      );
    }
    if (!increasing || request.confirmed) return execute(state, classified);
    return confirm(
      state,
      classified,
      `Switch execution mode from ${modeLabel(state.effectiveExecutionMode)} to ${modeLabel(requested)}?`,
    );
  }

  private evaluateLockdownChange(
    request: ExecutionPolicyRequest,
    state: ExecutionState,
  ): ExecutionPolicyDecision {
    const parsed = lockdownChangeFromArguments(request.arguments);
    if (!parsed) {
      return deny(
        state,
        request.execution,
        "INVALID_SKILL_INPUT",
        "The requested lockdown change is invalid.",
      );
    }
    if (parsed.enabled) {
      const classified = { ...request.execution, impact: "normal" as const };
      return request.userAuthorized || request.confirmed
        ? execute(state, classified)
        : confirm(
            state,
            classified,
            "Emergency lockdown was not clearly requested by the user.",
          );
    }
    const requestedMode = parsed.executionMode ?? "SAFE";
    if (compareExecutionModes(requestedMode, state.maxExecutionMode) > 0) {
      return deny(
        state,
        request.execution,
        "EXECUTION_MODE_EXCEEDS_MAX",
        `${modeLabel(requestedMode)} is disabled by the host configuration. Maximum available mode is ${modeLabel(state.maxExecutionMode)}.`,
      );
    }
    const classified = { ...request.execution, impact: "sensitive" as const };
    if (!request.userAuthorized && !request.confirmed) {
      return confirm(
        state,
        classified,
        "Disabling lockdown was not clearly requested by the user.",
      );
    }
    const needsConfirmation =
      state.lockdown ||
      isExecutionModeIncrease(state.effectiveExecutionMode, requestedMode);
    if (!needsConfirmation) return execute(state, classified);
    return request.confirmed
      ? execute(state, classified)
      : confirm(
          state,
          classified,
          `Disable lockdown and use ${modeLabel(requestedMode)} mode?`,
        );
  }
}

function executionModeFromArguments(input: unknown): ExecutionMode | undefined {
  if (!isRecord(input)) return undefined;
  const parsed = executionModeSchema.safeParse(input.mode);
  return parsed.success ? parsed.data : undefined;
}

function lockdownChangeFromArguments(
  input: unknown,
): { readonly enabled: boolean; readonly executionMode?: ExecutionMode } | undefined {
  if (!isRecord(input) || typeof input.enabled !== "boolean") return undefined;
  if (input.executionMode === undefined) return { enabled: input.enabled };
  const parsed = executionModeSchema.safeParse(input.executionMode);
  return parsed.success
    ? { enabled: input.enabled, executionMode: parsed.data }
    : undefined;
}

function execute(
  state: ExecutionState,
  execution: SkillExecutionMetadata,
): ExecutionPolicyDecision {
  return { action: "execute", state, execution };
}

function confirm(
  state: ExecutionState,
  execution: SkillExecutionMetadata,
  confirmationReason: string,
): ExecutionPolicyDecision {
  return { action: "confirm", state, execution, confirmationReason };
}

function deny(
  state: ExecutionState,
  execution: SkillExecutionMetadata,
  code: string,
  message: string,
): ExecutionPolicyDecision {
  return { action: "deny", state, execution, code, message };
}

function modeLabel(mode: ExecutionMode): string {
  switch (mode) {
    case "SAFE":
      return "Safe";
    case "AUTO":
      return "Auto";
    case "FULL_ACCESS":
      return "Full Access";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

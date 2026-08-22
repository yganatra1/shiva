import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  type AgentAuditPort,
  type SkillRunStatus,
} from "../agent/audit.js";
import {
  sanitizeAuditPayload,
  sanitizeAuditText,
  sanitizeSkillAuditInput,
  sanitizeSkillAuditResult,
} from "../security/audit-sanitizer.js";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
  type ActionConfirmation,
} from "../security/confirmation.js";
import { ExecutionPolicyEngine } from "../security/policy-engine.js";
import {
  LockdownActiveError,
  StaleExecutionStateError,
} from "../security/execution-state.js";
import { UnknownSkillError, type SkillRegistry } from "./registry.js";
import type {
  RegisteredSkill,
  SkillAuditDiagnostic,
  SkillContext,
  SkillExecutionMetadata,
  SkillFailure,
  SkillResult,
} from "./types.js";

interface ExecuteOptions {
  readonly userAuthorized?: boolean;
}

interface InternalExecuteOptions extends ExecuteOptions {
  readonly confirmation?: ActionConfirmation;
}

export interface PendingConfirmationView {
  readonly id: string;
  readonly skill: string;
  readonly sanitizedArguments: unknown;
  readonly reason: string;
  readonly expiresAt: string;
  readonly mutability: "read" | "write";
  readonly impact: "normal" | "sensitive";
}

export interface ResolvedConfirmationExecution {
  readonly skill: string;
  readonly arguments: unknown;
  readonly result: SkillResult<unknown>;
}

export class SkillExecutor {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly policy: ExecutionPolicyEngine,
    private readonly audit: AgentAuditPort = NOOP_AGENT_AUDIT,
    private readonly createRunId: () => string = () => randomUUID(),
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly onAuditError: (error: unknown) => void = () => {},
    private readonly confirmations: ConfirmationService = new ConfirmationService(
      new InMemoryConfirmationStore(),
      300_000,
    ),
  ) {}

  async execute(
    skillName: string,
    input: unknown,
    context: SkillContext,
    options: ExecuteOptions = {},
  ): Promise<SkillResult<unknown>> {
    return this.executeInternal(skillName, input, context, options);
  }

  private async executeInternal(
    skillName: string,
    input: unknown,
    context: SkillContext,
    options: InternalExecuteOptions,
  ): Promise<SkillResult<unknown>> {
    let skill: RegisteredSkill;
    try {
      skill = this.registry.get(skillName);
    } catch (error: unknown) {
      if (error instanceof UnknownSkillError) {
        const state = await this.policy.getState();
        return this.auditOnlyFailure(
          skillName,
          input,
          { mutability: "read", impact: "normal" },
          state.effectiveExecutionMode,
          null,
          context,
          "failed",
          "UNKNOWN_SKILL",
          "The requested skill is not available.",
        );
      }
      throw error;
    }

    if (context.allowedSkills && !context.allowedSkills.includes(skill.name)) {
      const state = await this.policy.getState();
      return this.auditOnlyFailure(
        skill.name,
        input,
        skill.execution,
        state.effectiveExecutionMode,
        null,
        context,
        "denied",
        "SKILL_NOT_AUTHORIZED_FOR_REQUEST",
        "The skill is outside the capabilities authorized by this request.",
      );
    }

    const parsed = skill.inputSchema.safeParse(input);
    if (!parsed.success) {
      const state = await this.policy.getState();
      return this.auditOnlyFailure(
        skill.name,
        input,
        skill.execution,
        state.effectiveExecutionMode,
        null,
        context,
        "failed",
        "INVALID_SKILL_INPUT",
        "The skill arguments did not match its validated input contract.",
        {
          validationIssues: parsed.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path.map((part) =>
              typeof part === "symbol" ? part.description ?? "symbol" : part,
            ),
            message: sanitizeAuditText(issue.message, 300),
          })),
        },
      );
    }

    let execution = skill.execution;
    if (skill.classifyExecution) {
      try {
        execution = await skill.classifyExecution(parsed.data, context);
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        const state = await this.policy.getState();
        return this.auditOnlyFailure(
          skill.name,
          parsed.data,
          skill.execution,
          state.effectiveExecutionMode,
          null,
          context,
          "failed",
          "SKILL_CLASSIFICATION_FAILED",
          "The skill's action classification could not be determined safely.",
        );
      }
    }

    const decision = await this.policy.evaluate({
      skill: skill.name,
      arguments: parsed.data,
      execution,
      userAuthorized: options.userAuthorized ?? false,
      confirmed: options.confirmation !== undefined,
    });
    let confirmation: ActionConfirmation | undefined;
    if (decision.action === "confirm") {
      confirmation = await this.confirmations.request({
        agentRunId: context.agentRunId,
        userId: context.userId,
        conversationId: context.conversationId,
        skill: skill.name,
        arguments: parsed.data,
        reason:
          decision.confirmationReason ??
          "This action requires confirmation.",
        executionMode: decision.state.effectiveExecutionMode,
        mutability: decision.execution.mutability,
        impact: decision.execution.impact,
        settingsRevision: decision.state.revision,
        now: context.now(),
      });
    }

    const auditId = this.createRunId();
    const monotonicStartedAt = this.monotonicNow();
    await this.audit.startSkillRun({
      id: auditId,
      agentRunId: context.agentRunId,
      userId: context.userId,
      conversationId: context.conversationId,
      skill: skill.name,
      input: sanitizeSkillAuditInput(skill.name, parsed.data),
      executionMode: decision.state.effectiveExecutionMode,
      mutability: decision.execution.mutability,
      impact: decision.execution.impact,
      confirmationId: options.confirmation?.id ?? confirmation?.id ?? null,
      startedAt: context.now(),
    });

    if (decision.action === "deny") {
      const result = failure(
        decision.code ?? "EXECUTION_DENIED",
        decision.message ?? "Shiva is not permitted to perform this action.",
      );
      await this.finishAuditSafely(
        auditId,
        skill.name,
        "denied",
        result,
        result.error.code,
        context,
        monotonicStartedAt,
      );
      return result;
    }

    if (decision.action === "confirm" && confirmation) {
      const result = confirmationFailure(confirmation);
      await this.finishAuditSafely(
        auditId,
        skill.name,
        "denied",
        result,
        result.error.code,
        context,
        monotonicStartedAt,
      );
      return result;
    }

    if (
      options.confirmation &&
      (options.confirmation.settingsRevision !== decision.state.revision ||
        confirmationRiskIncreased(options.confirmation, decision.execution))
    ) {
      const result = failure(
        "CONFIRMATION_STALE",
        "Execution settings or the action classification changed after this action was requested. Request the action again.",
      );
      await this.finishAuditSafely(
        auditId,
        skill.name,
        "denied",
        result,
        result.error.code,
        context,
        monotonicStartedAt,
      );
      return result;
    }

    let claimedConfirmation: ActionConfirmation | undefined;
    if (options.confirmation) {
      claimedConfirmation = await this.confirmations.claim(
        options.confirmation.id,
        context.userId,
        decision.state.revision,
        context.now(),
      );
      if (!claimedConfirmation) {
        const result = failure(
          "CONFIRMATION_INVALIDATED",
          "The pending approval was invalidated before execution. Request the action again.",
        );
        await this.finishAuditSafely(
          auditId,
          skill.name,
          "denied",
          result,
          result.error.code,
          context,
          monotonicStartedAt,
        );
        return result;
      }
    }

    let result: SkillResult<unknown>;
    try {
      if (decision.execution.mutability === "write" || claimedConfirmation) {
        const latestState = await this.policy.getState();
        if (latestState.revision !== decision.state.revision) {
          result = failure(
            "EXECUTION_STATE_CHANGED",
            "Execution settings changed before the action started. Request the action again.",
          );
          await this.finishAuditSafely(
            auditId,
            skill.name,
            "denied",
            result,
            result.error.code,
            context,
            monotonicStartedAt,
          );
          if (claimedConfirmation) {
            await this.completeConfirmationSafely(
              claimedConfirmation.id,
              context,
              false,
            );
          }
          return result;
        }
      }
      result = await this.executeAllowed(
        skill,
        parsed.data,
        {
          ...context,
          executionStateRevision: decision.state.revision,
        },
        auditId,
        monotonicStartedAt,
      );
    } catch (error: unknown) {
      if (claimedConfirmation) {
        await this.completeConfirmationSafely(
          claimedConfirmation.id,
          context,
          false,
        );
      }
      throw error;
    }
    if (claimedConfirmation) {
      await this.completeConfirmationSafely(
        claimedConfirmation.id,
        context,
        result.success,
      );
    }
    return result;
  }

  async getPendingConfirmation(
    userId: string,
    conversationId: string,
    now: Date,
  ): Promise<PendingConfirmationView | undefined> {
    const pending = await this.confirmations.findPending(
      userId,
      conversationId,
      now,
    );
    return pending ? confirmationView(pending) : undefined;
  }

  async resolveConfirmation(input: {
    readonly id: string;
    readonly approved: boolean;
    readonly skill?: string;
    readonly arguments?: unknown;
    readonly context: SkillContext;
  }): Promise<ResolvedConfirmationExecution> {
    let parsedArguments = input.arguments;
    if (input.approved && input.skill) {
      try {
        const skill = this.registry.get(input.skill);
        const parsed = skill.inputSchema.safeParse(input.arguments);
        if (parsed.success) parsedArguments = parsed.data;
      } catch (error: unknown) {
        if (!(error instanceof UnknownSkillError)) throw error;
      }
    }
    const resolution = await this.confirmations.resolve({
      id: input.id,
      userId: input.context.userId,
      conversationId: input.context.conversationId,
      approved: input.approved,
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.approved ? { arguments: parsedArguments } : {}),
      now: input.context.now(),
    });
    const resolvedSkill =
      resolution.confirmation?.skill ?? input.skill ?? "confirmation";

    if (resolution.outcome !== "approved") {
      return {
        skill: resolvedSkill,
        arguments: parsedArguments ?? {},
        result: confirmationResolutionFailure(resolution.outcome),
      };
    }
    if (!input.skill) {
      return {
        skill: resolvedSkill,
        arguments: {},
        result: failure(
          "CONFIRMATION_MISMATCH",
          "The approved action was missing its exact skill invocation.",
        ),
      };
    }
    const approvedConfirmation = resolution.confirmation;
    if (!approvedConfirmation) {
      return {
        skill: resolvedSkill,
        arguments: parsedArguments ?? {},
        result: failure(
          "CONFIRMATION_NOT_FOUND",
          "The approved confirmation record is unavailable.",
        ),
      };
    }

    let result: SkillResult<unknown>;
    try {
      result = await this.executeInternal(
        input.skill,
        parsedArguments,
        input.context,
        {
          userAuthorized: true,
          confirmation: approvedConfirmation,
        },
      );
    } finally {
      try {
        await this.confirmations.failApproved(
          input.id,
          input.context.userId,
          input.context.now(),
        );
      } catch (error: unknown) {
        this.reportAuditError(error);
      }
    }
    return { skill: input.skill, arguments: parsedArguments, result };
  }

  private async completeConfirmationSafely(
    id: string,
    context: SkillContext,
    succeeded: boolean,
  ): Promise<void> {
    try {
      const completed = await this.confirmations.complete(
        id,
        context.userId,
        context.now(),
        succeeded,
      );
      if (!completed) {
        this.reportAuditError(
          new Error("The executing confirmation could not be finalized."),
        );
      }
    } catch (error: unknown) {
      this.reportAuditError(error);
    }
  }

  private async executeAllowed(
    skill: RegisteredSkill,
    input: unknown,
    context: SkillContext,
    auditId: string,
    monotonicStartedAt: number,
  ): Promise<SkillResult<unknown>> {
    let reportedDiagnostic: SkillAuditDiagnostic | undefined;
    const executionContext: SkillContext = {
      ...context,
      reportAuditDiagnostic: (diagnostic) => {
        reportedDiagnostic ??= diagnostic;
      },
    };
    let result: SkillResult<unknown>;
    try {
      result = await skill.execute(input, executionContext);
    } catch (error: unknown) {
      if (context.signal?.aborted) {
        await this.finishAuditSafely(
          auditId,
          skill.name,
          "cancelled",
          null,
          "CANCELLED",
          context,
          monotonicStartedAt,
        );
        throw error;
      }
      result =
        error instanceof StaleExecutionStateError
          ? failure("EXECUTION_STATE_CHANGED", error.message)
          : error instanceof LockdownActiveError
            ? failure("LOCKDOWN_ACTIVE", error.message)
            : failure(
                "SKILL_EXECUTION_FAILED",
                "The skill could not complete its operation.",
              );
      await this.finishAuditSafely(
        auditId,
        skill.name,
        "failed",
        result,
        result.error.code,
        context,
        monotonicStartedAt,
      );
      return result;
    }

    await this.finishAuditSafely(
      auditId,
      skill.name,
      result.success ? "succeeded" : "failed",
      result,
      result.success ? null : result.error.code,
      context,
      monotonicStartedAt,
      reportedDiagnostic
        ? {
            boundary: {
              category: sanitizeAuditText(reportedDiagnostic.category, 100),
              reason: sanitizeAuditText(reportedDiagnostic.reason, 500),
            },
          }
        : undefined,
    );
    return result;
  }

  private async auditOnlyFailure(
    skill: string,
    input: unknown,
    execution: SkillExecutionMetadata,
    executionMode: "SAFE" | "AUTO" | "FULL_ACCESS",
    confirmationId: string | null,
    context: SkillContext,
    status: Exclude<SkillRunStatus, "running">,
    code: string,
    message: string,
    diagnostics?: SkillAuditDiagnostics,
  ): Promise<SkillResult<never>> {
    const id = this.createRunId();
    const monotonicStartedAt = this.monotonicNow();
    await this.audit.startSkillRun({
      id,
      agentRunId: context.agentRunId,
      userId: context.userId,
      conversationId: context.conversationId,
      skill,
      input: sanitizeSkillAuditInput(skill, input),
      executionMode,
      mutability: execution.mutability,
      impact: execution.impact,
      confirmationId,
      startedAt: context.now(),
    });
    const result = failure(code, message);
    await this.finishAuditSafely(
      id,
      skill,
      status,
      result,
      code,
      context,
      monotonicStartedAt,
      diagnostics,
    );
    return result;
  }

  private async finishAuditSafely(
    id: string,
    skill: string,
    status: Exclude<SkillRunStatus, "running">,
    result: unknown,
    errorCode: string | null,
    context: SkillContext,
    monotonicStartedAt: number,
    diagnostics?: SkillAuditDiagnostics,
  ): Promise<void> {
    try {
      const sanitizedResult = sanitizeSkillAuditResult(skill, result);
      await this.audit.finishSkillRun({
        id,
        status,
        result: diagnostics
          ? mergeDiagnostics(sanitizedResult, diagnostics)
          : sanitizedResult,
        errorCode: sanitizeErrorCode(errorCode),
        finishedAt: context.now(),
        durationMs: Math.max(
          0,
          Math.round(this.monotonicNow() - monotonicStartedAt),
        ),
      });
    } catch (error: unknown) {
      this.reportAuditError(error);
    }
  }

  private reportAuditError(error: unknown): void {
    try {
      this.onAuditError(error);
    } catch {
      // Observability must not change an already-determined action outcome.
    }
  }
}

interface SkillAuditDiagnostics {
  readonly boundary?: {
    readonly category: string;
    readonly reason: string;
  };
  readonly validationIssues?: readonly {
    readonly code: string;
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];
}

function failure(code: string, message: string): SkillFailure {
  return { success: false, error: { code, message } };
}

function sanitizeErrorCode(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = sanitizeAuditText(value, 100);
  return /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(sanitized)
    ? sanitized
    : "SANITIZED_ERROR";
}

function confirmationRiskIncreased(
  confirmation: ActionConfirmation,
  execution: SkillExecutionMetadata,
): boolean {
  return (
    (confirmation.mutability === "read" && execution.mutability === "write") ||
    (confirmation.impact === "normal" && execution.impact === "sensitive")
  );
}

function confirmationFailure(confirmation: ActionConfirmation): SkillFailure {
  return {
    success: false,
    error: {
      code: "CONFIRMATION_REQUIRED",
      message: `${confirmation.reason} Reply yes to approve this exact action or no to cancel.`,
      confirmation: {
        id: confirmation.id,
        skill: confirmation.skill,
        reason: confirmation.reason,
        expiresAt: confirmation.expiresAt.toISOString(),
      },
    },
  };
}

function confirmationResolutionFailure(
  outcome:
    | "denied"
    | "expired"
    | "mismatch"
    | "not_found"
    | "already_resolved",
): SkillFailure {
  switch (outcome) {
    case "denied":
      return failure("CONFIRMATION_DENIED", "The pending action was cancelled.");
    case "expired":
      return failure(
        "CONFIRMATION_EXPIRED",
        "That confirmation expired. Request the action again to create a new approval.",
      );
    case "mismatch":
      return failure(
        "CONFIRMATION_MISMATCH",
        "The tool or arguments changed, so the previous confirmation was rejected.",
      );
    case "not_found":
      return failure(
        "CONFIRMATION_NOT_FOUND",
        "No matching pending confirmation is available in this conversation.",
      );
    case "already_resolved":
      return failure(
        "CONFIRMATION_ALREADY_RESOLVED",
        "That confirmation has already been resolved and cannot be reused.",
      );
  }
}

function confirmationView(
  confirmation: ActionConfirmation,
): PendingConfirmationView {
  return {
    id: confirmation.id,
    skill: confirmation.skill,
    sanitizedArguments: confirmation.sanitizedArguments,
    reason: confirmation.reason,
    expiresAt: confirmation.expiresAt.toISOString(),
    mutability: confirmation.mutability,
    impact: confirmation.impact,
  };
}

function mergeDiagnostics(
  payload: unknown,
  diagnostics: SkillAuditDiagnostics,
): unknown {
  const sanitizedDiagnostics = sanitizeAuditPayload(diagnostics);
  if (isRecord(payload)) return { ...payload, diagnostics: sanitizedDiagnostics };
  return { result: payload, diagnostics: sanitizedDiagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

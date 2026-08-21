import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  REDACTED_SKILL_PAYLOAD,
  isRedactedAuditSkill,
  type AgentAuditPort,
  type SkillRunStatus,
} from "../agent/audit.js";
import { UnknownSkillError, type SkillRegistry } from "./registry.js";
import type {
  SkillAuditDiagnostic,
  SkillContext,
  SkillFailure,
  SkillResult,
} from "./types.js";
import type { PermissionPolicyEngine } from "../security/policy-engine.js";

export class SkillExecutor {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly policy: PermissionPolicyEngine,
    private readonly audit: AgentAuditPort = NOOP_AGENT_AUDIT,
    private readonly createRunId: () => string = () => randomUUID(),
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly onAuditError: (error: unknown) => void = () => {},
  ) {}

  async execute(
    skillName: string,
    input: unknown,
    context: SkillContext,
  ): Promise<SkillResult<unknown>> {
    let skill;
    try {
      skill = this.registry.get(skillName);
    } catch (error: unknown) {
      if (error instanceof UnknownSkillError) {
        return this.auditOnlyFailure(
          skillName,
          input,
          [],
          context,
          "failed",
          "UNKNOWN_SKILL",
          "The requested skill is not available.",
        );
      }
      throw error;
    }

    const auditId = this.createRunId();
    const auditStartedAt = context.now();
    const monotonicStartedAt = this.monotonicNow();
    await this.audit.startSkillRun({
      id: auditId,
      agentRunId: context.agentRunId,
      userId: context.userId,
      conversationId: context.conversationId,
      skill: skill.name,
      input: auditPayload(skill.name, input),
      permissions: skill.permissions,
      startedAt: auditStartedAt,
    });

    if (
      context.allowedSkills &&
      !context.allowedSkills.includes(skill.name)
    ) {
      const result = failure(
        "SKILL_NOT_AUTHORIZED_FOR_REQUEST",
        "The skill is outside the capabilities authorized by this request.",
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

    const permission = this.policy.evaluateAll(skill.permissions);
    if (!permission.allowed) {
      const result = failure(
        permission.reason === "confirmation_required"
          ? "CONFIRMATION_REQUIRED"
          : "PERMISSION_DENIED",
        permission.reason === "confirmation_required"
          ? "This action requires confirmation, which is not available yet."
          : "Shiva is not permitted to perform this action.",
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

    const parsed = skill.inputSchema.safeParse(input);
    if (!parsed.success) {
      const result = failure(
        "INVALID_SKILL_INPUT",
        "The skill arguments did not match its validated input contract.",
      );
      await this.finishAuditSafely(
        auditId,
        skill.name,
        "failed",
        result,
        result.error.code,
        context,
        monotonicStartedAt,
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
      return result;
    }

    let reportedDiagnostic: SkillAuditDiagnostic | undefined;
    const executionContext: SkillContext = {
      ...context,
      reportAuditDiagnostic: (diagnostic) => {
        reportedDiagnostic ??= diagnostic;
      },
    };
    let result: SkillResult<unknown>;
    try {
      result = await skill.execute(parsed.data, executionContext);
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
      const result = failure(
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

    // Once a side-effecting skill succeeds, an audit update failure must not
    // turn that real action into an apparent failure that invites a retry.
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
    permissions: readonly string[],
    context: SkillContext,
    status: Exclude<SkillRunStatus, "running">,
    code: string,
    message: string,
  ): Promise<SkillResult<never>> {
    const id = this.createRunId();
    const startedAt = context.now();
    const monotonicStartedAt = this.monotonicNow();
    await this.audit.startSkillRun({
      id,
      agentRunId: context.agentRunId,
      userId: context.userId,
      conversationId: context.conversationId,
      skill,
      input: auditPayload(skill, input),
      permissions,
      startedAt,
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
    );
    return result;
  }

  private finishAudit(
    id: string,
    skill: string,
    status: Exclude<SkillRunStatus, "running">,
    result: unknown,
    errorCode: string | null,
    context: SkillContext,
    monotonicStartedAt: number,
    diagnostics?: SkillAuditDiagnostics,
  ): Promise<void> {
    return this.audit.finishSkillRun({
      id,
      status,
      result: auditResultPayload(skill, result, diagnostics),
      errorCode,
      finishedAt: context.now(),
      durationMs: this.monotonicNow() - monotonicStartedAt,
    });
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
      await this.finishAudit(
        id,
        skill,
        status,
        result,
        errorCode,
        context,
        monotonicStartedAt,
        diagnostics,
      );
    } catch (error: unknown) {
      try {
        this.onAuditError(error);
      } catch {
        // Observability must not change an already-determined skill outcome.
      }
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

function auditPayload(skill: string, payload: unknown): unknown {
  if (skill === "workspace_terminal") {
    return workspaceCommandAuditPayload(payload);
  }
  return isRedactedAuditSkill(skill) ? REDACTED_SKILL_PAYLOAD : payload;
}

function auditResultPayload(
  skill: string,
  payload: unknown,
  diagnostics?: SkillAuditDiagnostics,
): unknown {
  if (skill !== "workspace_terminal") {
    return isRedactedAuditSkill(skill) ? REDACTED_SKILL_PAYLOAD : payload;
  }

  const failure = workspaceFailureAuditPayload(payload);
  if (!failure) return REDACTED_SKILL_PAYLOAD;
  return diagnostics ? { ...failure, diagnostics } : failure;
}

function workspaceCommandAuditPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return { receivedType: describeType(payload) };
  }

  const command =
    typeof payload.command === "string"
      ? sanitizeAuditText(payload.command, 80)
      : { receivedType: describeType(payload.command) };
  const args = Array.isArray(payload.args)
    ? payload.args.slice(0, 32).map((argument) =>
        typeof argument === "string"
          ? sanitizeAuditText(argument, 500)
          : { receivedType: describeType(argument) },
      )
    : payload.args === undefined
      ? []
      : { receivedType: describeType(payload.args) };
  const unexpectedKeys = Object.keys(payload)
    .filter((key) => key !== "command" && key !== "args")
    .slice(0, 32)
    .map((key) => sanitizeAuditText(key, 100));

  return {
    command,
    args,
    ...(unexpectedKeys.length > 0 ? { unexpectedKeys } : {}),
  };
}

function workspaceFailureAuditPayload(payload: unknown): unknown | undefined {
  if (!isRecord(payload) || payload.success !== false || !isRecord(payload.error)) {
    return undefined;
  }
  if (
    typeof payload.error.code !== "string" ||
    typeof payload.error.message !== "string"
  ) {
    return undefined;
  }
  return {
    success: false,
    error: {
      code: sanitizeAuditText(payload.error.code, 100),
      message: sanitizeAuditText(payload.error.message, 500),
    },
  };
}

function sanitizeAuditText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, maxLength);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

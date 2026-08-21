import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  REDACTED_SKILL_PAYLOAD,
  isRedactedAuditSkill,
  type AgentAuditPort,
  type SkillRunStatus,
} from "../agent/audit.js";
import { UnknownSkillError, type SkillRegistry } from "./registry.js";
import type { SkillContext, SkillFailure, SkillResult } from "./types.js";
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
      );
      return result;
    }

    let result: SkillResult<unknown>;
    try {
      result = await skill.execute(parsed.data, context);
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
  ): Promise<void> {
    return this.audit.finishSkillRun({
      id,
      status,
      result: auditPayload(skill, result),
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

function failure(code: string, message: string): SkillFailure {
  return { success: false, error: { code, message } };
}

function auditPayload(skill: string, payload: unknown): unknown {
  return isRedactedAuditSkill(skill)
    ? REDACTED_SKILL_PAYLOAD
    : payload;
}

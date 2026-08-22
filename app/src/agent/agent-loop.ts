import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  REDACTED_AGENT_REQUEST,
  type AgentAuditPort,
  type AgentRunStatus,
} from "./audit.js";
import type { SkillExecutor } from "../skills/executor.js";
import type { SkillRegistry } from "../skills/registry.js";
import type {
  AgentObservation,
  AgentPlanner,
  AgentRequest,
  AgentRunResult,
} from "./types.js";
import { AgentPlannerError } from "./planner.js";

export const DEFAULT_MAX_AGENT_STEPS = 8;
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 300_000;

export class AgentMaxStepsError extends Error {
  override readonly name = "AgentMaxStepsError";
}

export class AgentCancelledError extends Error {
  override readonly name = "AgentCancelledError";

  constructor(options?: ErrorOptions) {
    super("The agent request was cancelled.", options);
  }
}

export class AgentEvidenceError extends Error {
  override readonly name = "AgentEvidenceError";
}

export class AgentTimeoutError extends Error {
  override readonly name = "AgentTimeoutError";

  constructor(options?: ErrorOptions) {
    super("The agent request exceeded its deadline.", options);
  }
}

export class AgentLoop {
  constructor(
    private readonly planner: AgentPlanner,
    private readonly executor: SkillExecutor,
    private readonly registry: SkillRegistry,
    private readonly maxSteps = DEFAULT_MAX_AGENT_STEPS,
    private readonly now: () => Date = () => new Date(),
    private readonly createRunId: () => string = () => randomUUID(),
    private readonly audit: AgentAuditPort = NOOP_AGENT_AUDIT,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly onAuditError: (error: unknown) => void = () => {},
    private readonly requestTimeoutMs = DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) {
      throw new RangeError("Agent max steps must be an integer from 1 to 32.");
    }
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 1_800_000
    ) {
      throw new RangeError(
        "Agent request timeout must be an integer from 1 to 1800000 milliseconds.",
      );
    }
  }

  async run(request: AgentRequest): Promise<AgentRunResult> {
    const runId = this.createRunId();
    const observations: AgentObservation[] = [];
    const completedSkillCalls = new Map<
      string,
      AgentObservation["result"]
    >();
    const startedAt = this.now();
    const monotonicStartedAt = this.monotonicNow();
    await this.audit.startAgentRun({
      id: runId,
      userId: request.userId,
      conversationId: request.conversationId,
      // The planner now evaluates every turn before the skill scope exists.
      // Keep agent audit metadata useful without duplicating chat content.
      request: REDACTED_AGENT_REQUEST,
      startedAt,
    });

    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(),
      this.requestTimeoutMs,
    );
    deadlineTimer.unref();
    const scopedSignal = request.signal
      ? AbortSignal.any([request.signal, deadline.signal])
      : deadline.signal;
    const baseRequest: AgentRequest = {
      ...request,
      signal: scopedSignal,
    };
    let selectedSkills: readonly string[] | undefined;
    let pendingConfirmation:
      | Awaited<ReturnType<SkillExecutor["getPendingConfirmation"]>>
      | undefined;
    let plannerFeedback: string | undefined;
    let plannerFallbackReason: "INVALID_OUTPUT" | "INVALID_SCOPE" =
      "INVALID_OUTPUT";

    const fallBackToCore = async (
      reason: "INVALID_OUTPUT" | "INVALID_SCOPE",
      step: number,
    ): Promise<AgentRunResult> => {
      await this.finishAuditSafely(
        runId,
        "succeeded",
        step,
        `PlannerFallback${reason === "INVALID_OUTPUT" ? "InvalidOutput" : "InvalidScope"}`,
        monotonicStartedAt,
      );
      return {
        kind: "direct_chat",
        runId,
        response: undefined,
        steps: step,
        observations: [],
        plannerFallback: reason,
      };
    };

    let completedSteps = 0;
    try {
      selectedSkills = initialSkillScope(request, this.registry);
      pendingConfirmation = await this.executor.getPendingConfirmation(
        request.userId,
        request.conversationId,
        this.now(),
      );
      for (let step = 1; step <= this.maxSteps; step += 1) {
        completedSteps = step;
        throwIfAborted(baseRequest.signal);
        const scopedRequest: AgentRequest = selectedSkills
          ? { ...baseRequest, allowedSkills: selectedSkills }
          : withoutSkillScope(baseRequest);
        const correctionForAttempt = plannerFeedback;
        plannerFeedback = undefined;
        const planningContext = {
          request: scopedRequest,
          skills: allowedSkillSummaries(
            this.registry,
            scopedRequest.allowedSkills,
          ),
          observations: [...observations],
          step,
          maxSteps: this.maxSteps,
          now: this.now(),
          ...(pendingConfirmation ? { pendingConfirmation } : {}),
          ...(correctionForAttempt
            ? { plannerFeedback: correctionForAttempt }
            : {}),
        };
        let decision;
        try {
          decision = await this.planner.decide(planningContext);
        } catch (error: unknown) {
          if (
            error instanceof AgentPlannerError &&
            !selectedSkills &&
            observations.length === 0
          ) {
            return await fallBackToCore("INVALID_OUTPUT", step);
          }
          if (error instanceof AgentPlannerError) {
            plannerFallbackReason = "INVALID_OUTPUT";
            plannerFeedback =
              "Your previous decision could not be parsed even after its format retry. The active execution is still intact. Return one valid decision using only the frozen skills and existing observations; do not restart, switch to direct chat, or invent tool results.";
            continue;
          }
          throw error;
        }
        throwIfAborted(scopedRequest.signal);

        if (
          decision.type === "approve_confirmation" ||
          decision.type === "deny_confirmation"
        ) {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "Confirmation resolution was rejected because this run has already started another execution. Continue the active frozen plan and do not approve or deny a different pending action.";
            continue;
          }
          const confirmationContext = {
            agentRunId: runId,
            conversationId: scopedRequest.conversationId,
            userId: scopedRequest.userId,
            userName: scopedRequest.userName,
            timeZone: scopedRequest.timeZone,
            signal: scopedSignal,
            now: this.now,
          };
          const approval =
            decision.type === "approve_confirmation" ? decision : undefined;
          const resolved = approval
            ? await this.executor.resolveConfirmation({
                id: approval.confirmationId,
                approved: true,
                skill: approval.skill,
                arguments: approval.arguments,
                context: confirmationContext,
              })
            : await this.executor.resolveConfirmation({
                id: decision.confirmationId,
                approved: false,
                context: confirmationContext,
              });
          if (!this.registry.has(resolved.skill)) {
            plannerFeedback =
              "The confirmation reference was invalid or unavailable. Do not invent an approval result; answer the current task without claiming execution.";
            pendingConfirmation = undefined;
            continue;
          }
          selectedSkills = [resolved.skill];
          pendingConfirmation = undefined;
          observations.push({
            step,
            skill: resolved.skill,
            arguments: approval?.arguments ?? {},
            result: resolved.result,
          });
          continue;
        }

        let validatedScope: readonly string[] | undefined;
        if (decision.type === "skill_call") {
          try {
            validatedScope = freezeSkillScope(
              selectedSkills,
              decision.selectedSkills,
              decision.skill,
              this.registry,
            );
          } catch (error: unknown) {
            if (!(error instanceof AgentEvidenceError)) throw error;
            plannerFallbackReason = "INVALID_SCOPE";
            const validNames = this.registry
              .list()
              .map((skill) => skill.name)
              .join(", ");
            plannerFeedback = selectedSkills
              ? `Your previous skill_call was rejected because this run's skill scope is frozen. Repeat exactly selectedSkills=${JSON.stringify(selectedSkills)} and call only one of those skills. Preserve the current task and existing observations.`
              : `Your previous skill_call used an invalid called skill or scope. Choose a called skill only from this exact registered list: ${validNames}. selectedSkills must contain unique registered names, include the called skill, and be the complete minimal set for the current task.`;
            continue;
          }
        }

        if (decision.type === "direct_chat") {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "direct_chat was rejected because skill execution has already started. Keep the existing frozen scope and observations. Call another allowed skill if more evidence is needed, or return a grounded respond decision whose outcome matches the observations.";
            continue;
          }
          const result = {
            kind: "direct_chat" as const,
            runId,
            response: undefined,
            steps: step,
            observations: [...observations],
          };
          await this.finishAuditSafely(
            runId,
            "succeeded",
            completedSteps,
            null,
            monotonicStartedAt,
          );
          return result;
        }

        if (decision.type === "describe_capabilities") {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "describe_capabilities was rejected because this turn is already executing a task. Continue the existing frozen plan using its observations, then return a grounded respond decision.";
            continue;
          }
          const result = {
            kind: "response" as const,
            runId,
            response: describeCapabilities(this.registry),
            steps: step,
            observations: [...observations],
          };
          await this.finishAuditSafely(
            runId,
            "succeeded",
            completedSteps,
            null,
            monotonicStartedAt,
          );
          return result;
        }

        if (decision.type === "clarify") {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "clarify was rejected because execution has already begun. Do not pause or promise future work. Use the existing observations, call another skill inside the exact frozen scope if needed, or return a grounded success/failure response.";
            continue;
          }
          const result = {
            kind: "response" as const,
            runId,
            response: decision.message,
            steps: step,
            observations: [...observations],
          };
          await this.finishAuditSafely(
            runId,
            "succeeded",
            completedSteps,
            null,
            monotonicStartedAt,
          );
          return result;
        }

        if (decision.type === "respond") {
          try {
            assertResponseEvidence(decision, selectedSkills, observations);
          } catch (error: unknown) {
            if (!(error instanceof AgentEvidenceError)) throw error;
            plannerFeedback = buildResponseEvidenceFeedback(
              selectedSkills,
              observations,
            );
            continue;
          }
          const result = {
            kind: "response" as const,
            runId,
            response: decision.message,
            steps: step,
            observations: [...observations],
          };
          await this.finishAuditSafely(
            runId,
            "succeeded",
            completedSteps,
            null,
            monotonicStartedAt,
          );
          return result;
        }

        if (!validatedScope) {
          throw new AgentEvidenceError(
            "The planner did not establish a valid skill scope.",
          );
        }
        selectedSkills = validatedScope;

        const callKey = skillCallKey(decision);
        if (callKey && completedSkillCalls.has(callKey)) {
          const previous = completedSkillCalls.get(callKey);
          plannerFeedback = previous?.success
            ? `The identical ${decision.skill} call with the same arguments already succeeded in this run. It was not executed again. Use its existing observation, choose materially different arguments if another call is genuinely required, or return a grounded response.`
            : `The identical ${decision.skill} call with the same arguments already failed in this run${previous && !previous.success ? ` with code ${previous.error.code}` : ""}. It was not executed again. Use the existing failure observation to return a grounded failure, or choose a materially different allowed action.`;
          continue;
        }
        const result = await this.executor.execute(
          decision.skill,
          decision.arguments,
          {
            agentRunId: runId,
            conversationId: scopedRequest.conversationId,
            userId: scopedRequest.userId,
            userName: scopedRequest.userName,
            timeZone: scopedRequest.timeZone,
            allowedSkills: selectedSkills,
            signal: scopedSignal,
            now: this.now,
          },
          {
            userAuthorized: decision.authorization === "user_authorized",
          },
        );
        if (callKey) completedSkillCalls.set(callKey, result);
        observations.push({
          step,
          skill: decision.skill,
          arguments: decision.arguments,
          result,
        });
      }

      const maxStepsError = new AgentMaxStepsError(
        `Shiva reached the ${this.maxSteps}-step execution limit.`,
      );
      await this.finishAuditSafely(
        runId,
        "max_steps",
        completedSteps,
        maxStepsError.name,
        monotonicStartedAt,
      );
      if (observations.length === 0) {
        return {
          kind: "direct_chat",
          runId,
          response: undefined,
          steps: completedSteps,
          observations: [],
          plannerFallback: plannerFallbackReason,
        };
      }
      return {
        kind: "response",
        runId,
        response: buildMaxStepsResponse(observations),
        steps: completedSteps,
        observations: [...observations],
      };
    } catch (error: unknown) {
      const timedOut = deadline.signal.aborted && !request.signal?.aborted;
      const cancelled = request.signal?.aborted === true;
      const status: Exclude<AgentRunStatus, "running"> = cancelled
        ? "cancelled"
        : error instanceof AgentMaxStepsError
          ? "max_steps"
          : "failed";
      await this.finishAuditSafely(
        runId,
        status,
        completedSteps,
        timedOut ? "AgentTimeoutError" : safeErrorCode(error),
        monotonicStartedAt,
      );
      if (timedOut) {
        throw new AgentTimeoutError({ cause: error });
      }
      if (cancelled && !(error instanceof AgentCancelledError)) {
        throw new AgentCancelledError({ cause: error });
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private finishAudit(
    runId: string,
    status: Exclude<AgentRunStatus, "running">,
    stepCount: number,
    errorCode: string | null,
    monotonicStartedAt: number,
  ): Promise<void> {
    return this.audit.finishAgentRun({
      id: runId,
      status,
      stepCount,
      errorCode,
      finishedAt: this.now(),
      durationMs: this.monotonicNow() - monotonicStartedAt,
    });
  }

  private async finishAuditSafely(
    runId: string,
    status: Exclude<AgentRunStatus, "running">,
    stepCount: number,
    errorCode: string | null,
    monotonicStartedAt: number,
  ): Promise<void> {
    try {
      await this.finishAudit(
        runId,
        status,
        stepCount,
        errorCode,
        monotonicStartedAt,
      );
    } catch (error: unknown) {
      try {
        this.onAuditError(error);
      } catch {
        // Observability must not change an already-determined agent outcome.
      }
    }
  }
}

function skillCallKey(
  decision: Extract<import("./types.js").AgentDecision, { type: "skill_call" }>,
): string | undefined {
  try {
    return JSON.stringify({
      skill: decision.skill,
      arguments: sortJsonValue(decision.arguments),
    });
  } catch {
    // Normal planner arguments are JSON. If an injected planner violates that
    // contract, execute normally rather than suppressing a potentially distinct call.
    return undefined;
  }
}

function sortJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-JSON number.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cyclic JSON value.");
    seen.add(value);
    const sorted = value.map((entry) => sortJsonValue(entry, seen));
    seen.delete(value);
    return sorted;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cyclic JSON value.");
    seen.add(value);
    const sorted = Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry, seen)]),
    );
    seen.delete(value);
    return sorted;
  }
  throw new TypeError("Non-JSON value.");
}

function allowedSkillSummaries(
  registry: SkillRegistry,
  allowedSkills: readonly string[] | undefined,
) {
  const summaries = registry.list();
  if (!allowedSkills) return summaries;
  const allowed = new Set(allowedSkills);
  return summaries.filter((skill) => allowed.has(skill.name));
}

function withoutSkillScope(request: AgentRequest): AgentRequest {
  const {
    allowedSkills: _allowedSkills,
    ...unscoped
  } = request;
  return unscoped;
}

function initialSkillScope(
  request: AgentRequest,
  registry: SkillRegistry,
): readonly string[] | undefined {
  const declared = request.allowedSkills;
  return declared ? normalizeSkillScope(declared, registry) : undefined;
}

function freezeSkillScope(
  current: readonly string[] | undefined,
  proposed: readonly string[],
  calledSkill: string,
  registry: SkillRegistry,
): readonly string[] {
  const normalized = current
    ? normalizeSkillScope(proposed, registry)
    : normalizeInitialSkillScope(proposed, calledSkill, registry);
  if (
    current &&
    (current.length !== normalized.length ||
      current.some((skill, index) => skill !== normalized[index]))
  ) {
    throw new AgentEvidenceError(
      "The planner attempted to change the request's skill scope.",
    );
  }
  return current ?? normalized;
}

function normalizeInitialSkillScope(
  skills: readonly string[],
  calledSkill: string,
  registry: SkillRegistry,
): readonly string[] {
  if (!registry.has(calledSkill)) {
    throw new AgentEvidenceError("The planner selected an unknown skill.");
  }
  const registered = skills.filter((skill) => registry.has(skill));
  const normalized = [...new Set([...registered, calledSkill])].sort();
  if (normalized.length > 16) {
    throw new AgentEvidenceError("The planner selected an invalid skill scope.");
  }
  return normalized;
}

function normalizeSkillScope(
  skills: readonly string[],
  registry: SkillRegistry,
): readonly string[] {
  if (skills.length === 0 || skills.length > 16) {
    throw new AgentEvidenceError("The planner selected an invalid skill scope.");
  }
  const normalized = [...new Set(skills)].sort();
  if (
    normalized.length !== skills.length ||
    normalized.some((skill) => !registry.has(skill))
  ) {
    throw new AgentEvidenceError("The planner selected an invalid skill scope.");
  }
  return normalized;
}

function assertResponseEvidence(
  decision: Extract<import("./types.js").AgentDecision, { type: "respond" }>,
  selectedSkills: readonly string[] | undefined,
  observations: readonly AgentObservation[],
): void {
  if (!selectedSkills) {
    if (decision.outcome === "failure" && observations.length === 0) return;
    throw new AgentEvidenceError(
      "The planner attempted to respond without selected tool evidence.",
    );
  }

  const relevant = selectedSkills.map((skill) =>
    observations.filter((observation) => observation.skill === skill),
  );
  const valid =
    decision.outcome === "success"
      ? relevant.every((entries) =>
          entries.some((observation) => observation.result.success),
        )
      : relevant.some((entries) =>
          entries.some((observation) => !observation.result.success),
        );
  if (!valid) {
    throw new AgentEvidenceError(
      "The planner attempted to respond without required tool evidence.",
    );
  }
}

function buildResponseEvidenceFeedback(
  selectedSkills: readonly string[] | undefined,
  observations: readonly AgentObservation[],
): string {
  if (!selectedSkills) {
    return "Your respond decision was rejected because no skill plan or tool evidence exists. Choose direct_chat for an ordinary tool-free answer, choose a skill_call when the task requires a registered capability, or return a failure response only when the task truly cannot proceed.";
  }
  const status = selectedSkills.map((skill) => {
    const results = observations
      .filter((observation) => observation.skill === skill)
      .map((observation) =>
        observation.result.success ? "success" : "failure",
      );
    return `${skill}=${results.length > 0 ? results.join("|") : "not-called"}`;
  });
  return `Your respond decision was rejected because its outcome was not supported by the required tool evidence. Evidence status: ${status.join(", ")}. A success response requires at least one success for every frozen skill. A failure response requires at least one failed frozen-skill observation. Call missing skills or return the supported outcome without inventing results.`;
}

function buildMaxStepsResponse(
  observations: readonly AgentObservation[],
): string {
  if (observations.some((observation) => !observation.result.success)) {
    return "I couldn't complete this request safely because a required skill step failed and the planning limit was reached. I have not assumed or claimed success. Please retry or ask me to inspect the relevant configuration.";
  }
  return "I completed one or more verified tool steps, but I couldn't safely finish the answer within this turn's planning limit. I won't invent the remaining outcome. Please ask me to verify the result before repeating any action.";
}

function describeCapabilities(registry: SkillRegistry): string {
  const skills = registry.list();
  if (skills.length === 0) {
    return "I currently have no registered external skills. My normal conversation and memory capabilities remain available.";
  }
  const lines = skills.map(
    (skill) =>
      `- ${skill.name}: ${skill.description} (${skill.configured ? "configured" : "registered, but its external integration is not configured"})`,
  );
  return `I currently have ${skills.length} registered skill${skills.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n\nI also retain my normal conversation, memory, text, and voice paths outside this skill count.`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AgentCancelledError();
  }
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "AgentError";
}

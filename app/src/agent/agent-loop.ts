import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  REDACTED_AGENT_REQUEST,
  type AgentAuditPort,
  type AgentRunStatus,
} from "./audit";
import type {
  ResolvedConfirmationExecution,
  SkillExecutor,
} from "../skills/executor";
import type { SkillRegistry } from "../skills/registry";
import type {
  AgentObservation,
  AgentPlanner,
  AgentRequest,
  AgentRunResult,
} from "./types";
import { AgentPlannerError, type AgentTraceLogger } from "./planner";

export const DEFAULT_MAX_AGENT_STEPS = 12;
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 300_000;
/**
 * Caps how many times one write-mutability skill may succeed within a single
 * run. Set above 1 so a legitimate multi-target request (e.g. two separate
 * reminders in one message) still goes through; sized to stop a runaway
 * planner loop that keeps re-invoking the same write skill with reworded
 * arguments well before it reaches its step limit.
 */
export const MAX_WRITE_SKILL_SUCCESSES_PER_RUN = 2;
/**
 * Caps how many times one skill may fail within a single run before the loop
 * refuses to call it again. Without this, a planner facing a transient
 * failure (e.g. an unavailable external API) can reword its arguments each
 * step to dodge the exact-duplicate dedup above and keep retrying all the
 * way to the step limit — each step being a full paid planner call. Set to 2
 * (one retry) so a real API/core failure gets a single second chance, then
 * the run stops instead of burning steps on a call that keeps failing.
 */
export const MAX_SKILL_FAILURES_PER_RUN = 2;

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

export interface ApprovedConfirmationCompletion {
  readonly requestId: string;
  readonly responseId: string;
  readonly outcome: ResolvedConfirmationExecution["resolution"]["outcome"];
  readonly succeeded: boolean;
  readonly now: Date;
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
    private readonly onTrace?: AgentTraceLogger,
    private readonly onApprovedConfirmationWithoutDelegation?: (
      event: ApprovedConfirmationCompletion,
    ) => Promise<void>,
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
    // Circuit breaker against a planner that re-invokes the same write skill
    // over and over with slightly reworded arguments (e.g. rephrasing a
    // reminder's instruction/time each attempt) instead of recognizing its
    // own prior success — the exact-argument dedup above can't catch that
    // since the arguments genuinely differ each time.
    const writeSkillSuccessCounts = new Map<string, number>();
    // Circuit breaker against a planner that keeps retrying the same failing
    // skill (e.g. an API stuck returning UNAVAILABLE/TIMEOUT) with reworded
    // arguments each step instead of giving up — see MAX_SKILL_FAILURES_PER_RUN.
    const skillFailureCounts = new Map<string, number>();
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
    // selectedSkills is set only when the *incoming request itself* was
    // pre-scoped to exact skill names (an external caller's hard cap, e.g.
    // tests); otherwise every registered skill is allowed from step one —
    // there is no discovery/freeze step.
    let selectedSkills: readonly string[] | undefined;
    let pendingConfirmation:
      | Awaited<ReturnType<SkillExecutor["getPendingConfirmation"]>>
      | undefined;
    let plannerFeedback: string | undefined;
    let plannerFallbackReason: "INVALID_OUTPUT" | "INVALID_SCOPE" =
      "INVALID_OUTPUT";
    let approvedContinuationAwaitingTerminalResponse:
      | Omit<ApprovedConfirmationCompletion, "now">
      | undefined;

    const completeApprovedContinuationAfterTerminalResponse = async () => {
      const completion = approvedContinuationAwaitingTerminalResponse;
      if (!completion) return;
      approvedContinuationAwaitingTerminalResponse = undefined;
      await this.onApprovedConfirmationWithoutDelegation?.({
        ...completion,
        now: this.now(),
      });
    };

    const currentAllowedSkills = (): readonly string[] =>
      selectedSkills ?? this.registry.list().map((skill) => skill.name);

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
      pendingConfirmation = request.trigger
        ? undefined
        : await this.executor.getPendingConfirmation(
            request.userId,
            request.conversationId,
            this.now(),
          );
      for (let step = 1; step <= this.maxSteps; step += 1) {
        completedSteps = step;
        throwIfAborted(baseRequest.signal);
        const allowedNow = currentAllowedSkills();
        const scopedRequest: AgentRequest = {
          ...baseRequest,
          allowedSkills: allowedNow,
        };
        const correctionForAttempt = plannerFeedback;
        plannerFeedback = undefined;
        if (correctionForAttempt) {
          this.onTrace?.(
            { runId, step, correctionForAttempt },
            "agent loop feeding correction into next call",
          );
        }
        const planningContext = {
          request: scopedRequest,
          skills: allowedSkillSummaries(this.registry, allowedNow),
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
            await completeApprovedContinuationAfterTerminalResponse();
            await this.finishAuditSafely(
              runId,
              "failed",
              completedSteps,
              "PlannerInvalidOutput",
              monotonicStartedAt,
            );
            return {
              kind: "response",
              runId,
              response: buildPlannerFailureResponse(observations),
              steps: completedSteps,
              observations: [...observations],
            };
          }
          throw error;
        }
        this.onTrace?.({ runId, step, decision }, "agent loop received decision");
        throwIfAborted(scopedRequest.signal);

        if (
          decision.type === "approve_confirmation" ||
          decision.type === "deny_confirmation"
        ) {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "Confirmation resolution was rejected because this run has already started another execution. Continue the active plan and do not approve or deny a different pending action.";
            continue;
          }
          const confirmationContext = {
            agentRunId: runId,
            conversationId: scopedRequest.conversationId,
            userId: scopedRequest.userId,
            userName: scopedRequest.userName,
            timeZone: scopedRequest.timeZone,
            originalUserRequest:
              scopedRequest.delegationContinuation?.originalUserRequest ??
              scopedRequest.userMessage,
            ...(scopedRequest.sourceMessageId
              ? { sourceMessageId: scopedRequest.sourceMessageId }
              : {}),
            ...(scopedRequest.trigger ? { trigger: scopedRequest.trigger } : {}),
            ...(scopedRequest.delegationContinuation
              ? {
                  orchestrationRequestId:
                    scopedRequest.delegationContinuation.requestId,
                  agentResponseId:
                    scopedRequest.delegationContinuation.responseId,
                }
              : {}),
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
          const queuedDelegation = queuedDelegationFrom(resolved.result);
          const confirmationOrigin = resolved.resolution.originContext;
          if (
            resolved.resolution.outcome === "approved" &&
            !queuedDelegation &&
            confirmationOrigin.orchestrationRequestId &&
            confirmationOrigin.agentResponseId
          ) {
            const completion = {
              requestId: confirmationOrigin.orchestrationRequestId,
              responseId: confirmationOrigin.agentResponseId,
              outcome: resolved.resolution.outcome,
              succeeded: resolved.result.success,
            } satisfies Omit<ApprovedConfirmationCompletion, "now">;
            if (resolved.result.success) {
              // A successful non-delegation action is not terminal until Core
              // has reasoned over its observation and produced the response.
              // A later queued delegation returns earlier and never reaches
              // this completion path; the repository also fences child tasks.
              approvedContinuationAwaitingTerminalResponse = completion;
            } else {
              // A failed approved action has no remaining successful work to
              // summarize, so close its durable request immediately.
              await this.onApprovedConfirmationWithoutDelegation?.({
                ...completion,
                now: this.now(),
              });
            }
          }
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
          if (queuedDelegation) {
            const terminalResult = {
              kind: "delegated" as const,
              runId,
              response: queuedDelegation.userMessage,
              orchestrationRequestId: queuedDelegation.requestId,
              taskId: queuedDelegation.taskId,
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
            return terminalResult;
          }
          continue;
        }

        if (decision.type === "skill_call") {
          if (!this.registry.has(decision.skill)) {
            plannerFallbackReason = "INVALID_SCOPE";
            const validNames = this.registry
              .list()
              .map((skill) => skill.name)
              .join(", ");
            plannerFeedback = `Your previous skill_call used an unregistered skill. Choose a skill only from this exact registered list: ${validNames}.`;
            continue;
          }
          // Externally pre-scoped request: preserve the original hard,
          // exact-name cap unchanged — this path is for callers (tests,
          // future restricted integrations) that deliberately want a
          // narrower boundary than the whole registry, not for a normal task.
          if (selectedSkills && !selectedSkills.includes(decision.skill)) {
            plannerFallbackReason = "INVALID_SCOPE";
            plannerFeedback = `Your previous skill_call was rejected because this request is fixed to exactly these skills: ${selectedSkills.join(", ")}. Call one of those, or return a grounded response.`;
            continue;
          }
        }

        if (decision.type === "direct_chat") {
          if (scopedRequest.delegationContinuation) {
            plannerFeedback =
              "direct_chat was rejected because this is a continuation of durable delegated work. Reason from the saved execution context and latest agent response, then either delegate the next required agent task or return a grounded respond decision.";
            continue;
          }
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "direct_chat was rejected because skill execution has already started. Keep the existing observations. Call another allowed skill if more evidence is needed, or return a grounded respond decision.";
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
          this.onTrace?.({ runId, step, result }, "agent loop terminal decision");
          return result;
        }

        if (decision.type === "describe_capabilities") {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "describe_capabilities was rejected because this turn is already executing a task. Continue using its observations, then return a grounded respond decision.";
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
          this.onTrace?.({ runId, step, result }, "agent loop terminal decision");
          return result;
        }

        if (decision.type === "clarify") {
          if (selectedSkills || observations.length > 0) {
            plannerFeedback =
              "clarify was rejected because execution has already begun. Do not pause or promise future work. Use the existing observations, call another allowed skill if needed, or return a grounded response.";
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
          this.onTrace?.({ runId, step, result }, "agent loop terminal decision");
          return result;
        }

        if (decision.type === "respond") {
          try {
            assertResponseEvidence(
              observations,
              scopedRequest.delegationContinuation !== undefined,
            );
          } catch (error: unknown) {
            if (!(error instanceof AgentEvidenceError)) throw error;
            plannerFeedback = buildResponseEvidenceFeedback();
            continue;
          }
          const result = {
            kind: "response" as const,
            runId,
            response: decision.message,
            steps: step,
            observations: [...observations],
          };
          await completeApprovedContinuationAfterTerminalResponse();
          await this.finishAuditSafely(
            runId,
            "succeeded",
            completedSteps,
            null,
            monotonicStartedAt,
          );
          this.onTrace?.({ runId, step, result }, "agent loop terminal decision");
          return result;
        }

        if (decision.type !== "skill_call") {
          throw new AgentEvidenceError(
            "The planner did not establish a valid skill scope.",
          );
        }

        const callKey = skillCallKey(decision);
        if (callKey && completedSkillCalls.has(callKey)) {
          const previous = completedSkillCalls.get(callKey);
          plannerFeedback = previous?.success
            ? `The identical ${decision.skill} call with the same arguments already succeeded in this run. It was not executed again. Use its existing observation, choose materially different arguments if another call is genuinely required, or return a grounded response.`
            : `The identical ${decision.skill} call with the same arguments already failed in this run${previous && !previous.success ? ` with code ${previous.error.code}` : ""}. It was not executed again. Use the existing failure observation to return a grounded failure, or choose a materially different allowed action.`;
          continue;
        }
        if (
          (skillFailureCounts.get(decision.skill) ?? 0) >=
          MAX_SKILL_FAILURES_PER_RUN
        ) {
          plannerFeedback = `${decision.skill} has already failed ${MAX_SKILL_FAILURES_PER_RUN} time(s) in this run. It was not executed again. Do not retry it further; use the existing failure observation(s) to return a grounded failure response now.`;
          continue;
        }
        if (
          (writeSkillSuccessCounts.get(decision.skill) ?? 0) >=
          MAX_WRITE_SKILL_SUCCESSES_PER_RUN
        ) {
          const skillDefinition = this.registry.get(decision.skill);
          if (skillDefinition.execution.mutability === "write") {
            plannerFeedback = `${decision.skill} has already succeeded ${MAX_WRITE_SKILL_SUCCESSES_PER_RUN} time(s) in this run. It was not executed again, to avoid creating a duplicate of an action already completed. If the user's request genuinely named more distinct targets than that, explain that limit in your response instead; otherwise use the existing successful observation(s) and return a grounded response now.`;
            continue;
          }
        }
        const executionAllowedSkills = currentAllowedSkills();
        const result = await this.executor.execute(
          decision.skill,
          decision.arguments,
          {
            agentRunId: runId,
            conversationId: scopedRequest.conversationId,
            userId: scopedRequest.userId,
            userName: scopedRequest.userName,
            timeZone: scopedRequest.timeZone,
            originalUserRequest:
              scopedRequest.delegationContinuation?.originalUserRequest ??
              scopedRequest.userMessage,
            ...(scopedRequest.sourceMessageId
              ? { sourceMessageId: scopedRequest.sourceMessageId }
              : {}),
            ...(scopedRequest.trigger ? { trigger: scopedRequest.trigger } : {}),
            ...(scopedRequest.delegationContinuation
              ? {
                  orchestrationRequestId:
                    scopedRequest.delegationContinuation.requestId,
                  agentResponseId:
                    scopedRequest.delegationContinuation.responseId,
                }
              : {}),
            ...(executionAllowedSkills ? { allowedSkills: executionAllowedSkills } : {}),
            signal: scopedSignal,
            now: this.now,
          },
          {
            userAuthorized:
              decision.authorization === "user_authorized" ||
              scopedRequest.trigger?.source === "scheduled_task",
          },
        );
        if (callKey) completedSkillCalls.set(callKey, result);
        if (result.success && this.registry.get(decision.skill).execution.mutability === "write") {
          writeSkillSuccessCounts.set(
            decision.skill,
            (writeSkillSuccessCounts.get(decision.skill) ?? 0) + 1,
          );
        }
        if (!result.success) {
          skillFailureCounts.set(
            decision.skill,
            (skillFailureCounts.get(decision.skill) ?? 0) + 1,
          );
        }
        observations.push({
          step,
          skill: decision.skill,
          arguments: decision.arguments,
          result,
        });
        const queuedDelegation = queuedDelegationFrom(result);
        if (queuedDelegation) {
          const terminalResult = {
            kind: "delegated" as const,
            runId,
            response: queuedDelegation.userMessage,
            orchestrationRequestId: queuedDelegation.requestId,
            taskId: queuedDelegation.taskId,
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
          this.onTrace?.(
            { runId, step, result: terminalResult },
            "agent loop queued delegated work",
          );
          return terminalResult;
        }
        this.onTrace?.(
          { runId, step, skill: decision.skill, arguments: decision.arguments, result },
          "agent loop executed skill",
        );
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
      if (observations.length === 0 && !selectedSkills) {
        return {
          kind: "direct_chat",
          runId,
          response: undefined,
          steps: completedSteps,
          observations: [],
          plannerFallback: plannerFallbackReason,
        };
      }
      if (observations.length === 0) {
        await completeApprovedContinuationAfterTerminalResponse();
        return {
          kind: "response",
          runId,
          response: buildPlannerFailureResponse(observations),
          steps: completedSteps,
          observations: [],
        };
      }
      await completeApprovedContinuationAfterTerminalResponse();
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
  decision: Extract<import("./types").AgentDecision, { type: "skill_call" }>,
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

function initialSkillScope(
  request: AgentRequest,
  registry: SkillRegistry,
): readonly string[] | undefined {
  const declared = request.allowedSkills;
  return declared ? normalizeSkillScope(declared, registry) : undefined;
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
  observations: readonly AgentObservation[],
  hasAgentResponseEvidence = false,
): void {
  if (hasAgentResponseEvidence) return;
  if (observations.length === 0) {
    throw new AgentEvidenceError(
      "The planner attempted to respond without required tool evidence.",
    );
  }
}

interface QueuedDelegationData {
  readonly queued: true;
  readonly requestId: string;
  readonly taskId: string;
  readonly userMessage: string;
}

function queuedDelegationFrom(
  result: AgentObservation["result"],
): QueuedDelegationData | undefined {
  if (!result.success || !isRecord(result.data)) return undefined;
  return result.data.queued === true &&
    typeof result.data.requestId === "string" &&
    typeof result.data.taskId === "string" &&
    typeof result.data.userMessage === "string"
    ? {
        queued: true,
        requestId: result.data.requestId,
        taskId: result.data.taskId,
        userMessage: result.data.userMessage,
      }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildResponseEvidenceFeedback(): string {
  return "Your respond decision was rejected because no skill has been called yet this run. Choose direct_chat for an ordinary tool-free answer, or call the required skill before claiming live information or completed work.";
}

function buildPlannerFailureResponse(
  observations: readonly AgentObservation[],
): string {
  const confirmation = [...observations]
    .reverse()
    .find(
      (observation) =>
        !observation.result.success &&
        observation.result.error.code === "CONFIRMATION_REQUIRED",
    );
  if (confirmation && !confirmation.result.success) {
    return confirmation.result.error.message;
  }
  if (observations.length === 0) {
    return "I couldn't produce a valid tool plan for this request, so no action was executed.";
  }
  return "I completed the available tool step, but the planner returned invalid structured output twice, so I stopped instead of repeating the request.";
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

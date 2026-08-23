import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  REDACTED_AGENT_REQUEST,
  type AgentAuditPort,
  type AgentRunStatus,
} from "./audit";
import type { SkillExecutor } from "../skills/executor";
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
    private readonly onTrace?: AgentTraceLogger,
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
    // selectedSkills is set only when the *incoming request itself* was
    // pre-scoped to exact skill names (an external caller's hard cap, e.g.
    // tests) — that exact-match behavior is preserved unchanged below. The
    // normal path a real task takes is openPacks -> frozenPacks: once the
    // first skill_call happens, the pack(s) involved become frozen for the
    // rest of the run, and any skill within those packs may be called from
    // then on without having been named in advance. declaredSkills is just
    // the most recent skill_call's own bookkeeping, used only to check at
    // respond time that whatever the planner says it relied on was actually
    // attempted — it does not gate execution and never has to be repeated
    // verbatim across calls.
    let selectedSkills: readonly string[] | undefined;
    let openPacks: readonly string[] | undefined;
    let frozenPacks: readonly string[] | undefined;
    let declaredSkills: readonly string[] | undefined;
    let pendingConfirmation:
      | Awaited<ReturnType<SkillExecutor["getPendingConfirmation"]>>
      | undefined;
    let plannerFeedback: string | undefined;
    let plannerFallbackReason: "INVALID_OUTPUT" | "INVALID_SCOPE" =
      "INVALID_OUTPUT";

    const currentAllowedSkills = (): readonly string[] | undefined =>
      selectedSkills ??
      (frozenPacks
        ? skillsInPacks(this.registry, frozenPacks)
        : openPacks
          ? skillsInPacks(this.registry, openPacks)
          : undefined);

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
        const allowedNow = currentAllowedSkills();
        const scopedRequest: AgentRequest = allowedNow
          ? { ...baseRequest, allowedSkills: allowedNow }
          : withoutSkillScope(baseRequest);
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
          packs: this.registry.listPacks(),
          openPacks: openPacks ?? [],
          skills: allowedNow
            ? allowedSkillSummaries(this.registry, allowedNow)
            : [],
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
            !openPacks &&
            !frozenPacks &&
            observations.length === 0
          ) {
            return await fallBackToCore("INVALID_OUTPUT", step);
          }
          if (error instanceof AgentPlannerError) {
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
          if (selectedSkills || frozenPacks || observations.length > 0) {
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
          declaredSkills = [resolved.skill];
          pendingConfirmation = undefined;
          observations.push({
            step,
            skill: resolved.skill,
            arguments: approval?.arguments ?? {},
            result: resolved.result,
          });
          continue;
        }

        if (decision.type === "open_packs") {
          if (selectedSkills || frozenPacks) {
            plannerFeedback =
              "open_packs was rejected because this run's skill scope is already frozen. Continue with an allowed skill_call within the frozen scope, or return a grounded response.";
            continue;
          }
          try {
            const requested = normalizePackScope(decision.packs, this.registry);
            openPacks = openPacks
              ? [...new Set([...openPacks, ...requested])].sort()
              : requested;
          } catch (error: unknown) {
            if (!(error instanceof AgentEvidenceError)) throw error;
            const validPackNames = this.registry
              .listPacks()
              .map((pack) => pack.name)
              .join(", ");
            plannerFeedback = `Your previous open_packs call used an invalid or empty pack list. Choose only from this exact pack catalog: ${validPackNames}.`;
            continue;
          }
          continue;
        }

        if (decision.type === "skill_call") {
          if (selectedSkills) {
            const fixedSkills = selectedSkills;
            // Externally pre-scoped request: preserve the original hard,
            // exact-name cap unchanged — this path is for callers (tests,
            // future restricted integrations) that deliberately want a
            // narrower boundary than "the whole pack", not for a normal task.
            try {
              const proposedSkills = validateDeclaredSkills(
                decision.selectedSkills,
                decision.skill,
                this.registry,
              );
              if (
                proposedSkills.some(
                  (skill) => !fixedSkills.includes(skill),
                )
              ) {
                throw new AgentEvidenceError(
                  "The planner selected a skill outside the request's fixed scope.",
                );
              }
              declaredSkills = proposedSkills;
            } catch (error: unknown) {
              if (!(error instanceof AgentEvidenceError)) throw error;
              plannerFallbackReason = "INVALID_SCOPE";
              plannerFeedback = `Your previous skill_call was rejected because this request is fixed to exactly these skills: ${fixedSkills.join(", ")}. Call one of those, or return a grounded response.`;
              continue;
            }
          } else {
            try {
              const proposedSkills = validateDeclaredSkills(
                decision.selectedSkills,
                decision.skill,
                this.registry,
              );
              const proposedPacks =
                frozenPacks ??
                openPacks ??
                packsForSkills(this.registry, proposedSkills);
              const allowedInProposedPacks = skillsInPacks(
                this.registry,
                proposedPacks,
              );
              if (
                proposedSkills.some(
                  (skill) => !allowedInProposedPacks.includes(skill),
                )
              ) {
                throw new AgentEvidenceError(
                  "The planner selected a skill outside this run's frozen packs.",
                );
              }
              frozenPacks ??= proposedPacks;
              declaredSkills = proposedSkills;
            } catch (error: unknown) {
              if (!(error instanceof AgentEvidenceError)) throw error;
              plannerFallbackReason = "INVALID_SCOPE";
              if (frozenPacks) {
                plannerFeedback = `Your previous skill_call was rejected: '${decision.skill}' is not in this run's frozen pack(s) (${frozenPacks.join(", ")}). Call a skill from an already-frozen pack, or return a grounded response — packs cannot be opened or changed once execution has started.`;
              } else {
                const validNames = this.registry
                  .list()
                  .map((skill) => skill.name)
                  .join(", ");
                plannerFeedback = `Your previous skill_call used an invalid or unregistered skill/selectedSkills value. Choose a called skill only from this exact registered list: ${validNames}. selectedSkills must contain unique registered names and include the called skill.`;
              }
              continue;
            }
          }
        }

        if (decision.type === "direct_chat") {
          if (selectedSkills || frozenPacks || observations.length > 0) {
            plannerFeedback =
              "direct_chat was rejected because skill execution has already started. Keep the existing frozen scope and observations. Call another allowed skill if more evidence is needed, or return a grounded respond decision.";
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
          if (selectedSkills || frozenPacks || observations.length > 0) {
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
          this.onTrace?.({ runId, step, result }, "agent loop terminal decision");
          return result;
        }

        if (decision.type === "clarify") {
          if (selectedSkills || frozenPacks || observations.length > 0) {
            plannerFeedback =
              "clarify was rejected because execution has already begun. Do not pause or promise future work. Use the existing observations, call another skill inside the frozen packs if needed, or return a grounded response.";
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
            assertResponseEvidence(declaredSkills, observations);
          } catch (error: unknown) {
            if (!(error instanceof AgentEvidenceError)) throw error;
            plannerFeedback = buildResponseEvidenceFeedback(
              declaredSkills,
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
          this.onTrace?.({ runId, step, result }, "agent loop terminal decision");
          return result;
        }

        if (decision.type !== "skill_call" || !declaredSkills) {
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
            ...(executionAllowedSkills ? { allowedSkills: executionAllowedSkills } : {}),
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
      if (
        observations.length === 0 &&
        !selectedSkills &&
        !openPacks &&
        !frozenPacks
      ) {
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
        return {
          kind: "response",
          runId,
          response: buildPlannerFailureResponse(observations),
          steps: completedSteps,
          observations: [],
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

function skillsInPacks(
  registry: SkillRegistry,
  packs: readonly string[],
): readonly string[] {
  const wanted = new Set(packs);
  return registry
    .list()
    .filter((skill) => wanted.has(skill.pack))
    .map((skill) => skill.name);
}

function packsForSkills(
  registry: SkillRegistry,
  skills: readonly string[],
): readonly string[] {
  return [
    ...new Set(skills.map((skill) => registry.get(skill).pack)),
  ].sort();
}

function normalizePackScope(
  packs: readonly string[],
  registry: SkillRegistry,
): readonly string[] {
  if (packs.length === 0 || packs.length > 16) {
    throw new AgentEvidenceError("The planner selected an invalid pack list.");
  }
  const normalized = [...new Set(packs)].sort();
  if (
    normalized.length !== packs.length ||
    normalized.some((pack) => !registry.hasPack(pack))
  ) {
    throw new AgentEvidenceError("The planner selected an invalid pack list.");
  }
  return normalized;
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

/**
 * Format-only validation of a skill_call's declared selectedSkills: real
 * registered names, unique, bounded, and including the called skill. Unlike
 * the old freezeSkillScope, this never compares against a previous value —
 * a task's declared plan is allowed to grow or change across steps as the
 * planner discovers what it actually needs, as long as every skill it names
 * stays inside whatever the true authorization boundary is (checked
 * separately: the request's fixed scope, or this run's frozen packs).
 */
function validateDeclaredSkills(
  skills: readonly string[],
  calledSkill: string,
  registry: SkillRegistry,
): readonly string[] {
  if (!registry.has(calledSkill)) {
    throw new AgentEvidenceError("The planner selected an unknown skill.");
  }
  if (skills.length === 0 || skills.length > 16) {
    throw new AgentEvidenceError("The planner selected an invalid skill scope.");
  }
  const normalized = [...new Set(skills)].sort();
  if (
    normalized.length !== skills.length ||
    normalized.some((skill) => !registry.has(skill)) ||
    !normalized.includes(calledSkill)
  ) {
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
  declaredSkills: readonly string[] | undefined,
  observations: readonly AgentObservation[],
): void {
  if (!declaredSkills) {
    throw new AgentEvidenceError(
      "The planner attempted to respond without a skill plan or tool evidence.",
    );
  }
  const attempted = declaredSkills.some((skill) =>
    observations.some((observation) => observation.skill === skill),
  );
  if (!attempted) {
    throw new AgentEvidenceError(
      "The planner attempted to respond without required tool evidence.",
    );
  }
}

function buildResponseEvidenceFeedback(
  declaredSkills: readonly string[] | undefined,
  observations: readonly AgentObservation[],
): string {
  if (!declaredSkills) {
    return "Your respond decision was rejected because no skill plan or tool evidence exists. Choose direct_chat for an ordinary tool-free answer, or call the required skill before claiming live information or completed work.";
  }
  const status = declaredSkills.map((skill) => {
    const results = observations
      .filter((observation) => observation.skill === skill)
      .map((observation) =>
        observation.result.success ? "success" : "failure",
      );
    return `${skill}=${results.length > 0 ? results.join("|") : "not-called"}`;
  });
  return `Your respond decision was rejected because none of the skills in selectedSkills were actually called this run. Evidence status: ${status.join(", ")}. Call at least one of them, or return a response grounded in a skill you already attempted.`;
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
  const packs = registry.listPacks();
  const sections = packs.map((pack) => {
    const packSkills = skills.filter((skill) => skill.pack === pack.name);
    const lines = packSkills.map(
      (skill) =>
        `  - ${skill.name}: ${skill.description} (${skill.configured ? "configured" : "registered, but its external integration is not configured"})`,
    );
    return `${pack.name} — ${pack.description}\n${lines.join("\n")}`;
  });
  return `I currently have ${skills.length} registered skill${skills.length === 1 ? "" : "s"} across ${packs.length} capability area${packs.length === 1 ? "" : "s"}:\n${sections.join("\n")}\n\nI also retain my normal conversation, memory, text, and voice paths outside this skill count.`;
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

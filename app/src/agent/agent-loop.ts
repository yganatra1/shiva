import { randomUUID } from "node:crypto";

import {
  NOOP_AGENT_AUDIT,
  REDACTED_EXPENSE_AGENT_REQUEST,
  isExpenseAuditSkill,
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
    const completedExpenseCalls = new Map<
      string,
      AgentObservation["result"]
    >();
    const startedAt = this.now();
    const monotonicStartedAt = this.monotonicNow();
    await this.audit.startAgentRun({
      id: runId,
      userId: request.userId,
      conversationId: request.conversationId,
      request:
        request.requiredSkills?.some(isExpenseAuditSkill) ||
        request.allowedSkills?.some(isExpenseAuditSkill)
        ? REDACTED_EXPENSE_AGENT_REQUEST
        : request.userMessage,
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
    const scopedRequest: AgentRequest = {
      ...request,
      signal: scopedSignal,
    };

    let completedSteps = 0;
    try {
      for (let step = 1; step <= this.maxSteps; step += 1) {
        completedSteps = step;
        throwIfAborted(scopedRequest.signal);
        const decision = await this.planner.decide({
          request: scopedRequest,
          skills: allowedSkillSummaries(
            this.registry,
            scopedRequest.allowedSkills,
          ),
          observations: [...observations],
          step,
          maxSteps: this.maxSteps,
          now: this.now(),
        });
        throwIfAborted(scopedRequest.signal);

        if (decision.type === "respond") {
          assertResponseEvidence(decision, scopedRequest, observations);
          const result = {
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

        if (
          scopedRequest.allowedSkills &&
          !scopedRequest.allowedSkills.includes(decision.skill)
        ) {
          throw new AgentEvidenceError(
            "The planner selected a skill outside the request's authorized scope.",
          );
        }

        const expenseCallKey = recordExpenseCallKey(decision);
        let result = expenseCallKey
          ? completedExpenseCalls.get(expenseCallKey)
          : undefined;
        if (result === undefined) {
          result = await this.executor.execute(
            decision.skill,
            decision.arguments,
            {
              agentRunId: runId,
              conversationId: scopedRequest.conversationId,
              userId: scopedRequest.userId,
              userName: scopedRequest.userName,
              timeZone: scopedRequest.timeZone,
              ...(scopedRequest.allowedSkills
                ? { allowedSkills: scopedRequest.allowedSkills }
                : {}),
              signal: scopedSignal,
              now: this.now,
            },
          );
          if (expenseCallKey) {
            completedExpenseCalls.set(expenseCallKey, result);
          }
        }
        observations.push({
          step,
          skill: decision.skill,
          arguments: decision.arguments,
          result,
        });
      }

      throw new AgentMaxStepsError(
        `Shiva reached the ${this.maxSteps}-step execution limit.`,
      );
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

function recordExpenseCallKey(
  decision: Extract<import("./types.js").AgentDecision, { type: "skill_call" }>,
): string | undefined {
  if (decision.skill !== "record_expense") return undefined;

  try {
    return JSON.stringify(sortJsonValue(decision.arguments));
  } catch {
    // Normal planner arguments are JSON. If an injected planner violates that
    // contract, execute normally rather than risk suppressing a distinct call.
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

function assertResponseEvidence(
  decision: Extract<import("./types.js").AgentDecision, { type: "respond" }>,
  request: AgentRequest,
  observations: readonly AgentObservation[],
): void {
  const required = request.requiredSkills ?? [];
  if (required.length === 0) return;

  const relevant = required.map((skill) =>
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

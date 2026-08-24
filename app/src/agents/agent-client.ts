import type { AgentRegistry } from "./agent-registry";
import type { AgentDelegationResult } from "./types";

const DEFAULT_DELEGATE_TIMEOUT_MS = 300_000;
const MAX_DELEGATE_TIMEOUT_MS = 600_000;
/** Extra slack over the agent-side timeout for its own network/processing time. */
const CLIENT_TIMEOUT_BUFFER_MS = 5_000;

export type AgentDelegationFailure =
  | "AGENT_NOT_FOUND"
  | "AGENT_OFFLINE"
  | "AGENT_UNREACHABLE"
  | "TRANSPORT_UNAVAILABLE"
  | "AGENT_TIMEOUT"
  | "AGENT_FAILED"
  | "CANCELLED";

export class AgentDelegationError extends Error {
  override readonly name = "AgentDelegationError";

  constructor(
    readonly failure: AgentDelegationFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DelegateOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type AgentTraceLogger = (
  detail: Record<string, unknown>,
  message: string,
) => void;

/**
 * shiva-api's generic way to hand a self-contained goal to any registered
 * agent process and wait for its answer — the piece that makes "delegate to
 * an agent" a foundation rather than one-off code per agent. A new agent is
 * a new AgentRegistry entry; this client and the delegate_to_agent skill
 * that calls it never change.
 */
export class AgentClient {
  private readonly onTrace: AgentTraceLogger;

  constructor(
    private readonly registry: AgentRegistry,
    options: { readonly onTrace?: AgentTraceLogger } = {},
  ) {
    this.onTrace = options.onTrace ?? (() => {});
  }

  async delegate(
    agentName: string,
    goal: string,
    options: DelegateOptions = {},
  ): Promise<AgentDelegationResult> {
    if (!this.registry.has(agentName)) {
      throw new AgentDelegationError(
        "AGENT_NOT_FOUND",
        `No agent named '${agentName}' is registered.`,
      );
    }
    const agent = this.registry.get(agentName);
    if (!agent.baseUrl) {
      throw new AgentDelegationError(
        "AGENT_UNREACHABLE",
        `The '${agentName}' agent has no legacy HTTP endpoint.`,
      );
    }
    options.signal?.throwIfAborted();

    const timeoutMs = clampTimeout(options.timeoutMs);
    const timeoutSignal = AbortSignal.timeout(timeoutMs + CLIENT_TIMEOUT_BUFFER_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${agent.baseUrl}/v1/delegate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal }),
        signal,
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        if (options.signal?.aborted) {
          throw new AgentDelegationError("CANCELLED", "The delegated goal was cancelled.");
        }
        this.onTrace({ agentName, timeoutMs }, "agent client: delegate request timed out");
        throw new AgentDelegationError(
          "AGENT_TIMEOUT",
          `The '${agentName}' agent did not respond in time.`,
        );
      }
      this.onTrace({ agentName, err: String(error) }, "agent client: could not reach agent");
      throw new AgentDelegationError(
        "AGENT_UNREACHABLE",
        `The '${agentName}' agent could not be reached.`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const message = await readErrorMessage(response);
      this.onTrace(
        { agentName, status: response.status },
        "agent client: agent reported a delegation failure",
      );
      throw new AgentDelegationError(
        "AGENT_FAILED",
        message ?? `The '${agentName}' agent could not attempt this goal.`,
      );
    }

    const body = (await response.json()) as {
      success?: unknown;
      summary?: unknown;
      steps?: unknown;
    };
    if (typeof body.success !== "boolean" || typeof body.summary !== "string") {
      throw new AgentDelegationError(
        "AGENT_FAILED",
        `The '${agentName}' agent returned an unexpected response.`,
      );
    }
    this.onTrace({ agentName, success: body.success }, "agent client: delegation resolved");
    return {
      success: body.success,
      summary: body.summary,
      ...(typeof body.steps === "number" ? { steps: body.steps } : {}),
    };
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_DELEGATE_TIMEOUT_MS;
  return Math.min(MAX_DELEGATE_TIMEOUT_MS, Math.max(1_000, timeoutMs));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === "string" ? body.error.message : undefined;
  } catch {
    return undefined;
  }
}

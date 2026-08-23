import { z } from "zod";

import {
  DEVICE_COMMAND_STATUSES,
  DeviceDispatchError,
  type DeviceCommandResult,
  type DeviceDispatcher,
  type DeviceDispatchFailure,
  type DispatchOptions,
} from "./device-dispatcher";

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
/** Extra slack over the device-side timeout for the device agent's own network/processing time. */
const CLIENT_TIMEOUT_BUFFER_MS = 5_000;

const deviceCommandResultSchema = z.object({
  commandId: z.string(),
  status: z.enum(DEVICE_COMMAND_STATUSES),
  result: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
});

const FAILURE_BY_STATUS: Readonly<Record<number, DeviceDispatchFailure>> = {
  503: "DEVICE_NOT_CONNECTED",
  504: "DEVICE_TIMEOUT",
  409: "DEVICE_DISCONNECTED",
  499: "CANCELLED",
};

export type DeviceTraceLogger = (
  detail: Record<string, unknown>,
  message: string,
) => void;

export interface DeviceServiceClientOptions {
  /** e.g. http://127.0.0.1:3002 — no trailing slash or path. */
  readonly baseUrl: string;
  readonly onTrace?: DeviceTraceLogger;
}

/**
 * Compatibility client for the device agent's single-command /v1/dispatch
 * endpoint. The production main runtime no longer constructs this client or
 * registers direct device skills; every phone goal now goes through
 * delegate_to_agent/AgentClient and /v1/delegate. The adapter remains useful
 * for focused protocol tests and older internal callers.
 */
export class DeviceServiceClient implements DeviceDispatcher {
  private readonly baseUrl: string;
  private readonly onTrace: DeviceTraceLogger;

  constructor(options: DeviceServiceClientOptions) {
    this.baseUrl = options.baseUrl;
    this.onTrace = options.onTrace ?? (() => {});
  }

  async dispatch(
    type: string,
    commandArguments: Readonly<Record<string, string>>,
    options: DispatchOptions = {},
  ): Promise<DeviceCommandResult> {
    options.signal?.throwIfAborted();
    const timeoutMs = clampTimeout(options.timeoutMs);
    const timeoutSignal = AbortSignal.timeout(timeoutMs + CLIENT_TIMEOUT_BUFFER_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, arguments: commandArguments, timeoutMs }),
        signal,
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        if (options.signal?.aborted) {
          throw new DeviceDispatchError("CANCELLED", "The device command was cancelled.");
        }
        this.onTrace(
          { type, timeoutMs },
          "device service client: request to the device agent timed out",
        );
        throw new DeviceDispatchError(
          "DEVICE_TIMEOUT",
          "The device did not respond in time.",
        );
      }
      this.onTrace(
        { type, err: String(error) },
        "device service client: could not reach the device agent",
      );
      throw new DeviceDispatchError(
        "DEVICE_SEND_FAILED",
        "The command could not be sent to the phone.",
        { cause: error },
      );
    }

    if (!response.ok) {
      const failure = FAILURE_BY_STATUS[response.status] ?? "DEVICE_SEND_FAILED";
      const message = await readErrorMessage(response);
      this.onTrace(
        { type, status: response.status, failure },
        "device service client: the device agent reported a dispatch failure",
      );
      throw new DeviceDispatchError(failure, message ?? "The device command failed.");
    }

    const body: unknown = await response.json();
    const parsed = deviceCommandResultSchema.safeParse(body);
    if (!parsed.success) {
      this.onTrace(
        { type, issues: parsed.error.issues },
        "device service client: the device agent returned an unexpected response shape",
      );
      throw new DeviceDispatchError(
        "DEVICE_SEND_FAILED",
        "the device agent returned an unexpected response.",
      );
    }
    this.onTrace({ type, status: parsed.data.status }, "device service client: dispatch resolved");
    const { commandId, status, result, error } = parsed.data;
    return {
      commandId,
      status,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  async isConnected(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { connected?: unknown };
      return body.connected === true;
    } catch {
      return false;
    }
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, timeoutMs));
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

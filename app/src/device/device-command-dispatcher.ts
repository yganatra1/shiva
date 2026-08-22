import { randomUUID } from "node:crypto";

import {
  buildDeviceCommandMessage,
  deviceCommandResultMessageSchema,
  type DeviceCommand,
  type DeviceCommandResult,
} from "./device-protocol.js";

export type DeviceDispatchFailure =
  | "DEVICE_NOT_CONNECTED"
  | "DEVICE_TIMEOUT"
  | "DEVICE_DISCONNECTED"
  | "DEVICE_SEND_FAILED"
  | "CANCELLED";

export class DeviceDispatchError extends Error {
  override readonly name = "DeviceDispatchError";

  constructor(
    readonly failure: DeviceDispatchFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DeviceTransport {
  send(message: string): void;
}

interface PendingCommand {
  readonly resolve: (result: DeviceCommandResult) => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;

export interface DispatchOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type DeviceTraceLogger = (
  detail: Record<string, unknown>,
  message: string,
) => void;

/**
 * Owns the single live Android device connection and correlates outbound
 * device_command messages with their device_command_result reply by ID. One
 * device per personal Shiva instance — a new connection replaces the old one
 * rather than fanning out, matching the single-user, single-phone reality
 * this is built for.
 */
export class DeviceCommandDispatcher {
  private transport: DeviceTransport | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly createCommandId: () => string;
  private readonly now: () => Date;
  private readonly onTrace: DeviceTraceLogger;

  constructor(
    options: {
      readonly createCommandId?: () => string;
      readonly now?: () => Date;
      readonly onTrace?: DeviceTraceLogger;
    } = {},
  ) {
    this.createCommandId = options.createCommandId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.onTrace = options.onTrace ?? (() => {});
  }

  /** A new connection replaces any previous one; its pending commands fail closed. */
  connect(transport: DeviceTransport): void {
    if (this.transport && this.transport !== transport) {
      this.onTrace(
        { pendingCount: this.pending.size },
        "device dispatcher: new connection is replacing an existing one",
      );
      this.failAllPending(
        new DeviceDispatchError(
          "DEVICE_DISCONNECTED",
          "A new device connection replaced this one before the command completed.",
        ),
      );
    }
    this.transport = transport;
    this.onTrace({}, "device dispatcher: connected");
  }

  disconnect(transport: DeviceTransport): void {
    if (this.transport !== transport) return;
    this.transport = undefined;
    this.onTrace(
      { pendingCount: this.pending.size },
      "device dispatcher: disconnected",
    );
    this.failAllPending(
      new DeviceDispatchError(
        "DEVICE_DISCONNECTED",
        "The device disconnected before this command completed.",
      ),
    );
  }

  isConnected(): boolean {
    return this.transport !== undefined;
  }

  async dispatch(
    type: string,
    commandArguments: Readonly<Record<string, string>>,
    options: DispatchOptions = {},
  ): Promise<DeviceCommandResult> {
    const transport = this.transport;
    if (!transport) {
      this.onTrace({ type }, "device dispatcher: dispatch rejected, no device connected");
      throw new DeviceDispatchError(
        "DEVICE_NOT_CONNECTED",
        "No device is currently connected.",
      );
    }
    options.signal?.throwIfAborted();

    const timeoutMs = clampTimeout(options.timeoutMs);
    const createdAt = this.now();
    const command: DeviceCommand = {
      id: this.createCommandId(),
      type,
      arguments: commandArguments,
      createdAtEpochMs: createdAt.getTime(),
      expiresAtEpochMs: createdAt.getTime() + timeoutMs,
    };

    return new Promise<DeviceCommandResult>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        this.pending.delete(command.id);
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        cleanup();
        reject(
          new DeviceDispatchError("CANCELLED", "The device command was cancelled."),
        );
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        this.onTrace(
          { type, commandId: command.id, timeoutMs },
          "device dispatcher: command timed out waiting for a reply",
        );
        cleanup();
        reject(
          new DeviceDispatchError(
            "DEVICE_TIMEOUT",
            "The device did not respond in time.",
          ),
        );
      }, timeoutMs);
      // Deliberately not unref'd: an outstanding device command is a live
      // operation a caller is actively awaiting, not idle housekeeping — the
      // process should stay alive for it the same way it would for any other
      // pending request, not exit as if nothing were happening.

      this.pending.set(command.id, {
        resolve: (result) => {
          if (settled) return;
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          if (settled) return;
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        transport.send(buildDeviceCommandMessage(command));
        this.onTrace(
          { type, commandId: command.id, arguments: commandArguments },
          "device dispatcher: command sent",
        );
      } catch (error: unknown) {
        cleanup();
        reject(
          new DeviceDispatchError(
            "DEVICE_SEND_FAILED",
            "The command could not be sent to the device.",
            { cause: error },
          ),
        );
      }
    });
  }

  /** Feed one raw text WebSocket message from the device. Silently ignores anything unrecognized. */
  handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.onTrace({ raw }, "device dispatcher: received unparsable message");
      return;
    }
    const message = deviceCommandResultMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.onTrace(
        { raw, issues: message.error.issues },
        "device dispatcher: received a message that didn't match the result schema",
      );
      return;
    }
    const pending = this.pending.get(message.data.result.commandId);
    // Unknown, already-resolved, or expired-and-timed-out command IDs are
    // dropped rather than treated as an error — a late reply after this
    // dispatcher already gave up is expected, not a protocol violation.
    const { commandId, status, result, error } = message.data.result;
    if (!pending) {
      this.onTrace(
        { commandId, status },
        "device dispatcher: result for an unknown/expired command, ignored",
      );
    } else {
      this.onTrace({ commandId, status }, "device dispatcher: result matched a pending command");
    }
    pending?.resolve({
      commandId,
      status,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    });
  }

  private failAllPending(error: DeviceDispatchError): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(error);
    }
  }
}

/** Maps a thrown DeviceDispatchError to a skill failure code/message; rethrows anything else. */
export function deviceErrorToFailure(
  error: unknown,
): { readonly code: string; readonly message: string } {
  if (!(error instanceof DeviceDispatchError)) throw error;
  switch (error.failure) {
    case "DEVICE_NOT_CONNECTED":
      return {
        code: "DEVICE_NOT_CONNECTED",
        message: "No phone is currently connected to Shiva.",
      };
    case "DEVICE_TIMEOUT":
      return {
        code: "DEVICE_TIMEOUT",
        message: "The phone did not respond in time.",
      };
    case "DEVICE_DISCONNECTED":
      return {
        code: "DEVICE_DISCONNECTED",
        message: "The phone disconnected before this command completed.",
      };
    default:
      return {
        code: "DEVICE_COMMAND_SEND_FAILED",
        message: "The command could not be sent to the phone.",
      };
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, timeoutMs));
}

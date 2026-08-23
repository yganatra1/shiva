/**
 * shiva-api never talks to the Android app directly — the live connection,
 * command correlation, and timeouts live in the device agent, a separate
 * process (app/src/agents/device). This module holds only what skills need
 * to depend on: the result/error shapes and the dispatch contract itself.
 * See DeviceServiceClient for the concrete implementation that reaches the
 * device agent over HTTP.
 */

export const DEVICE_COMMAND_STATUSES = [
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
  "DENIED",
] as const;
export type DeviceCommandStatus = (typeof DEVICE_COMMAND_STATUSES)[number];

export interface DeviceCommandResult {
  readonly commandId: string;
  readonly status: DeviceCommandStatus;
  readonly result?: Readonly<Record<string, string>>;
  readonly error?: string;
}

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

export interface DispatchOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** What every device skill depends on — satisfied by DeviceServiceClient. */
export interface DeviceDispatcher {
  dispatch(
    type: string,
    commandArguments: Readonly<Record<string, string>>,
    options?: DispatchOptions,
  ): Promise<DeviceCommandResult>;
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

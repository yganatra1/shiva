import { z } from "zod";

/** Command types the Android app currently has a real handler for. */
export const IMPLEMENTED_DEVICE_COMMAND_TYPES = [
  "device.contacts.search",
  "device.phone.call",
  "device.notifications.list",
  "device.notifications.read",
  "device.notification.send",
  "device.camera.capture",
  "device.app.open",
  "device.app.list",
  "device.sms.send",
  "device.location.get",
  "device.status.get",
] as const;

/**
 * Prepared in the Android manifest/Device Access but with no handler yet.
 * Kept here only so a future skill addition has a documented, agreed name to
 * target — the server must never dispatch one of these; the device would
 * just answer UNSUPPORTED.
 */
export const PLANNED_DEVICE_COMMAND_TYPES = [
  "device.notifications.reply",
  "device.sms.read",
  "device.microphone.record",
  "device.microphone.stream",
  "device.whatsapp.send",
  "device.whatsapp.reply",
  "device.whatsapp.call",
] as const;

export interface DeviceCommand {
  readonly id: string;
  readonly type: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

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

/** Small metadata fields (name, phone, mime, etc.). */
const DEVICE_RESULT_FIELD_MAX = 2_000;
/** Base64 JPEG from the phone (camera capture or UI screenshot) can be up to ~512 KiB raw (~700 KiB encoded). */
const DEVICE_RESULT_IMAGE_FIELD_MAX = 1_500_000;

const deviceCommandStatusSchema = z.preprocess((value) => {
  if (typeof value === "string") return value.trim().toUpperCase();
  return value;
}, z.enum(DEVICE_COMMAND_STATUSES));

const deviceCommandResultValueSchema = z.string().max(DEVICE_RESULT_IMAGE_FIELD_MAX);

const deviceCommandResultSchema = z
  .object({
    commandId: z.string().trim().min(1).max(200),
    status: deviceCommandStatusSchema,
    result: z.record(z.string(), deviceCommandResultValueSchema).optional(),
    error: z.string().max(DEVICE_RESULT_FIELD_MAX).optional(),
  })
  .strict();

export const deviceCommandResultMessageSchema = z
  .object({
    type: z.literal("device_command_result"),
    result: deviceCommandResultSchema,
  })
  .strict();

export function buildDeviceCommandMessage(command: DeviceCommand): string {
  return JSON.stringify({ type: "device_command", command });
}

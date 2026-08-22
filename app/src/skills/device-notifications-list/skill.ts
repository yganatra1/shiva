import { z } from "zod";

import { defineSkill } from "../define-skill.js";
import type { SkillContext, SkillResult } from "../types.js";
import {
  deviceErrorToFailure,
  type DeviceCommandDispatcher,
} from "../../device/device-command-dispatcher.js";

const inputSchema = z.object({});

export type DeviceNotificationsListInput = z.infer<typeof inputSchema>;
export interface DeviceNotificationsListOutput {
  readonly status: "COMPLETED" | "FAILED" | "UNSUPPORTED" | "DENIED";
  readonly result?: Readonly<Record<string, string>>;
}

export function createDeviceNotificationsListSkill(
  dispatcher?: DeviceCommandDispatcher,
) {
  return defineSkill<DeviceNotificationsListInput, DeviceNotificationsListOutput>({
    name: "device_notifications_list",
    description:
      "Lists recent notifications on the connected phone through the Android companion app. Returns whatever notification fields the device reports (each one likely has a key you can pass to device_notifications_read for the full content). Requires the phone to be connected right now.",
    inputDescription: "{}",
    pack: "device",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      _input: DeviceNotificationsListInput,
      context: SkillContext,
    ): Promise<SkillResult<DeviceNotificationsListOutput>> {
      if (!dispatcher) {
        return {
          success: false,
          error: {
            code: "DEVICE_UNAVAILABLE",
            message: "The device command channel is not available.",
          },
        };
      }
      try {
        const result = await dispatcher.dispatch(
          "device.notifications.list",
          {},
          context.signal ? { signal: context.signal } : {},
        );
        if (result.status !== "COMPLETED") {
          return {
            success: false,
            error: {
              code: `DEVICE_COMMAND_${result.status}`,
              message: result.error ?? `The phone reported ${result.status}.`,
            },
          };
        }
        return {
          success: true,
          data: { status: result.status, ...(result.result ? { result: result.result } : {}) },
        };
      } catch (error: unknown) {
        if (context.signal?.aborted) throw error;
        return { success: false, error: deviceErrorToFailure(error) };
      }
    },
  });
}

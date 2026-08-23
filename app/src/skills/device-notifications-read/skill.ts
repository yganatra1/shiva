import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  deviceErrorToFailure,
  type DeviceCommandDispatcher,
} from "../../device/device-command-dispatcher";

const inputSchema = z.object({
  key: z.string().trim().min(1).max(500),
});

export type DeviceNotificationsReadInput = z.infer<typeof inputSchema>;
export interface DeviceNotificationsReadOutput {
  readonly status: "COMPLETED" | "FAILED" | "UNSUPPORTED" | "DENIED";
  readonly result?: Readonly<Record<string, string>>;
}

export function createDeviceNotificationsReadSkill(
  dispatcher?: DeviceCommandDispatcher,
) {
  return defineSkill<DeviceNotificationsReadInput, DeviceNotificationsReadOutput>({
    name: "device_notifications_read",
    description:
      "Reads the full content of one notification on the connected phone, identified by the key returned from device_notifications_list. Requires the phone to be connected right now.",
    inputDescription: '{ "key": string (from device_notifications_list) }',
    pack: "device",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: DeviceNotificationsReadInput,
      context: SkillContext,
    ): Promise<SkillResult<DeviceNotificationsReadOutput>> {
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
          "device.notifications.read",
          { key: input.key },
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

import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  deviceErrorToFailure,
  type DeviceDispatcher,
} from "../../device/device-dispatcher";

const inputSchema = z
  .object({
    number: z.string().trim().min(1).max(32),
    /** true starts the call immediately; false/omitted just opens the dialer pre-filled. */
    direct: z.boolean().default(false),
  })
  .strict();

export type DeviceCallInput = z.infer<typeof inputSchema>;
export interface DeviceCallOutput {
  readonly status: "COMPLETED" | "FAILED" | "UNSUPPORTED" | "DENIED";
  readonly result?: Readonly<Record<string, string>>;
}

export function createDeviceCallSkill(dispatcher?: DeviceDispatcher) {
  return defineSkill<DeviceCallInput, DeviceCallOutput>({
    name: "device_call",
    description:
      "Calls a phone number through the connected Android companion app. With direct=true it starts the call immediately; with direct=false (default) it only opens the phone's dialer pre-filled with the number, without actually calling. Requires the phone to be connected right now.",
    inputDescription:
      '{ "number": string, "direct"?: boolean (default false; true actually places the call) }',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: true,
    async execute(
      input: DeviceCallInput,
      context: SkillContext,
    ): Promise<SkillResult<DeviceCallOutput>> {
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
          "device.phone.call",
          { number: input.number, direct: String(input.direct) },
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

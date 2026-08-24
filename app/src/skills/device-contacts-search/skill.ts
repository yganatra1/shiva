import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillContext, SkillResult } from "../types";
import {
  deviceErrorToFailure,
  type DeviceDispatcher,
} from "../../device/device-dispatcher";

const inputSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
  })
  .strict();

export type DeviceContactsSearchInput = z.infer<typeof inputSchema>;
export interface DeviceContactsSearchOutput {
  readonly status: "COMPLETED" | "FAILED" | "UNSUPPORTED" | "DENIED";
  readonly result?: Readonly<Record<string, string>>;
}

export function createDeviceContactsSearchSkill(
  dispatcher?: DeviceDispatcher,
) {
  return defineSkill<DeviceContactsSearchInput, DeviceContactsSearchOutput>({
    name: "device_contacts_search",
    description:
      "Searches the phone's local contacts by name via the connected Android companion app and returns whatever contact fields the device reports (name, phone, etc.). Requires the phone to be connected right now.",
    inputDescription: '{ "query": string (name to search for) }',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(
      input: DeviceContactsSearchInput,
      context: SkillContext,
    ): Promise<SkillResult<DeviceContactsSearchOutput>> {
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
          "device.contacts.search",
          { query: input.query },
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


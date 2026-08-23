import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  DeviceDispatchError,
  type DeviceCommandDispatcher,
} from "./device-command-dispatcher";

const dispatchBodySchema = z
  .object({
    type: z.string().trim().min(1).max(200),
    arguments: z.record(z.string(), z.string()),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  })
  .strict();

export interface DispatchRouteOptions {
  readonly dispatcher: DeviceCommandDispatcher;
}

/**
 * shiva-api's internal-only view of the phone for the 5 direct, single-shot
 * device skills (device_call, device_contacts_search, ...): it sends one
 * high-level device.* command and waits for the real result, without ever
 * holding the Android WebSocket itself. Not exposed publicly — reachable
 * only over the loopback/Compose-internal network shiva-api calls it on.
 */
export function registerDispatchRoute(
  app: FastifyInstance,
  options: DispatchRouteOptions,
): void {
  app.post("/v1/dispatch", async (request, reply) => {
    const parsed = dispatchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_DISPATCH_REQUEST",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        },
      });
    }

    // Mirrors the client's own fetch abort: if shiva-api gives up on this
    // request (its caller cancelled, or it hit its own timeout), stop
    // waiting on the phone for a reply nobody is listening for anymore.
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    request.raw.on("close", onClose);

    try {
      const { type, arguments: commandArguments, timeoutMs } = parsed.data;
      const result = await options.dispatcher.dispatch(type, commandArguments, {
        signal: controller.signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      return reply.status(200).send(result);
    } catch (error: unknown) {
      if (!(error instanceof DeviceDispatchError)) throw error;
      return reply.status(statusForFailure(error.failure)).send({
        error: { code: error.failure, message: error.message },
      });
    } finally {
      request.raw.off("close", onClose);
    }
  });

  app.get("/v1/status", async () => ({
    connected: options.dispatcher.isConnected(),
  }));
}

function statusForFailure(failure: DeviceDispatchError["failure"]): number {
  switch (failure) {
    case "DEVICE_NOT_CONNECTED":
      return 503;
    case "DEVICE_TIMEOUT":
      return 504;
    case "DEVICE_DISCONNECTED":
      return 409;
    case "CANCELLED":
      return 499;
    default:
      return 502;
  }
}

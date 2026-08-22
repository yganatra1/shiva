import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";

import type { DeviceCommandDispatcher } from "../device/device-command-dispatcher.js";

const HEARTBEAT_INTERVAL_MS = 25_000;
const querySchema = z.object({ token: z.string().optional() }).strict();

export interface DeviceSocketRouteOptions {
  readonly dispatcher: DeviceCommandDispatcher;
  /** When set, the phone must connect with a matching ?token= query param. */
  readonly authToken?: string;
}

/**
 * The Android companion app's single connection: the server pushes
 * device_command messages and the phone replies with device_command_result,
 * correlated by DeviceCommandDispatcher. No audio/binary frames here, unlike
 * the voice socket — every message is JSON text.
 */
export function registerDeviceSocketRoute(
  app: FastifyInstance,
  options: DeviceSocketRouteOptions,
): void {
  app.route<{ Querystring: unknown }>({
    method: "GET",
    url: "/device/ws",
    handler: (_request, reply) =>
      reply.status(426).header("upgrade", "websocket").send({
        error: {
          code: "UPGRADE_REQUIRED",
          message: "The device endpoint requires a WebSocket upgrade.",
        },
      }),
    wsHandler: (socket, request) => {
      if (options.authToken) {
        const parsedQuery = querySchema.safeParse(request.query);
        const token = parsedQuery.success ? parsedQuery.data.token : undefined;
        if (!token || !constantTimeEquals(token, options.authToken)) {
          socket.close(4401, "unauthorized");
          return;
        }
      }

      const transport = { send: (message: string) => socket.send(message) };
      options.dispatcher.connect(transport);

      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      socket.on("pong", () => {
        alive = true;
      });
      socket.on("message", (data: RawData, isBinary: boolean) => {
        alive = true;
        if (isBinary) return;
        options.dispatcher.handleMessage(Buffer.from(toBytes(data)).toString("utf8"));
      });
      socket.on("error", (error) => {
        request.log.warn({ err: error }, "Device socket failed");
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        options.dispatcher.disconnect(transport);
      });
    },
  });
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return data as Uint8Array;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

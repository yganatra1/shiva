import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";

import type { DeviceCommandDispatcher } from "./device-command-dispatcher";

const HEARTBEAT_INTERVAL_MS = 25_000;
const querySchema = z.object({ token: z.string().optional() }).strict();

export interface DeviceSocketRouteOptions {
  readonly dispatcher: DeviceCommandDispatcher;
  /** When set, the phone must connect with a matching ?token= query param. */
  readonly authToken?: string;
}

/**
 * The Android companion app's single connection: this process pushes
 * device_command messages and the phone replies with device_command_result,
 * correlated by DeviceCommandDispatcher. No audio/binary frames here, unlike
 * shiva-api's voice socket — every message is JSON text.
 *
 * shiva-api never terminates this connection itself: it relays the phone's
 * WebSocket through to here unmodified (see app/src/api/device-socket-relay-route.ts)
 * so the Android app's configured server URL never has to change.
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
      request.log.info(
        { remoteAddress: request.ip, authRequired: Boolean(options.authToken) },
        "Device socket connection attempt",
      );

      if (options.authToken) {
        const parsedQuery = querySchema.safeParse(request.query);
        const token = parsedQuery.success ? parsedQuery.data.token : undefined;
        if (!token) {
          request.log.warn(
            { remoteAddress: request.ip },
            "Device socket rejected: no ?token= query param was sent",
          );
          socket.close(4401, "unauthorized");
          return;
        }
        if (!constantTimeEquals(token, options.authToken)) {
          request.log.warn(
            { remoteAddress: request.ip },
            "Device socket rejected: token did not match DEVICE_WS_TOKEN",
          );
          socket.close(4401, "unauthorized");
          return;
        }
      }

      const transport = { send: (message: string) => socket.send(message) };
      options.dispatcher.connect(transport);
      request.log.info({ remoteAddress: request.ip }, "Device socket connected");

      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) {
          request.log.warn(
            "Device socket missed its heartbeat and is being terminated",
          );
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
        if (isBinary) {
          request.log.debug("Device socket ignored an unexpected binary message");
          return;
        }
        const text = Buffer.from(toBytes(data)).toString("utf8");
        request.log.debug({ bytes: text.length }, "Device socket message received");
        options.dispatcher.handleMessage(text);
      });
      socket.on("error", (error) => {
        request.log.warn({ err: error }, "Device socket failed");
      });
      socket.on("close", (code, reason) => {
        request.log.info(
          { code, reason: reason.toString("utf8") },
          "Device socket disconnected",
        );
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

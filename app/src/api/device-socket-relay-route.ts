import type { FastifyInstance } from "fastify";
import { WebSocket as UpstreamWebSocket, type RawData } from "ws";

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface DeviceSocketRelayRouteOptions {
  /** The device agent's HTTP base URL, e.g. http://127.0.0.1:3002 — no path/query. */
  readonly deviceAgentUrl: string;
}

/**
 * shiva-api never terminates the Android app's device connection itself —
 * the device agent (app/src/agents/device, its own process) owns the live
 * socket, command correlation, and auth token check. This route only relays
 * raw frames between the phone and the device agent byte-for-byte, so the
 * Android app's configured server URL and `/device/ws` path never have to
 * change.
 */
export function registerDeviceSocketRelayRoute(
  app: FastifyInstance,
  options: DeviceSocketRelayRouteOptions,
): void {
  const upstreamOrigin = toWebSocketOrigin(options.deviceAgentUrl);

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
        { remoteAddress: request.ip },
        "Device socket relay: connection attempt",
      );

      const search = new URL(request.raw.url ?? "/device/ws", "http://internal").search;
      const upstream = new UpstreamWebSocket(`${upstreamOrigin}/device/ws${search}`);

      let upstreamOpen = false;
      let closed = false;
      const pendingFromPhone: { data: RawData; isBinary: boolean }[] = [];

      // terminate(), not close(): a graceful close handshake depends on the
      // peer cooperating, and this relay's whole job is fast pass-through —
      // it would rather drop both legs immediately (the phone reconnects on
      // its own) than leave a zombie connection waiting out ws's close timeout.
      const closeBoth = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          socket.terminate();
        }
        if (
          upstream.readyState === UpstreamWebSocket.OPEN ||
          upstream.readyState === UpstreamWebSocket.CONNECTING
        ) {
          upstream.terminate();
        }
      };

      upstream.on("open", () => {
        upstreamOpen = true;
        for (const frame of pendingFromPhone.splice(0)) {
          upstream.send(frame.data, { binary: frame.isBinary });
        }
      });
      upstream.on("message", (data: RawData, isBinary: boolean) => {
        socket.send(data as never, { binary: isBinary });
      });
      upstream.on("close", (code: number, reason: Buffer) => {
        request.log.info(
          { code, reason: reason.toString("utf8") },
          "Device socket relay: device-service connection closed",
        );
        closeBoth();
      });
      upstream.on("error", (error) => {
        request.log.warn(
          { err: error },
          "Device socket relay: could not reach device-service",
        );
        closeBoth();
      });

      // The phone can be flaky (cell network, backgrounding) — this leg needs
      // its own heartbeat rather than relying on the device-service<->relay
      // leg's, which only proves the relay itself is alive.
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) {
          request.log.warn(
            "Device socket relay: phone missed its heartbeat and is being terminated",
          );
          closeBoth();
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
        if (!upstreamOpen) {
          pendingFromPhone.push({ data, isBinary });
          return;
        }
        upstream.send(data, { binary: isBinary });
      });
      socket.on("error", (error) => {
        request.log.warn({ err: error }, "Device socket relay: phone connection failed");
      });
      socket.on("close", (code, reason) => {
        request.log.info(
          { code, reason: reason.toString("utf8") },
          "Device socket relay: phone disconnected",
        );
        closeBoth();
      });
    },
  });
}

function toWebSocketOrigin(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

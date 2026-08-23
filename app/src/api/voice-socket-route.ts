import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";

import type { ShivaChatService } from "../services/chat-service";
import type { VoicePlaybackCoordinator } from "../voice/playback-coordinator";
import type { ASRProvider, TTSProvider } from "../voice/provider";
import type { StreamingSpeechChunkerOptions } from "../voice/speech-chunker";
import type { VoicePerformanceTracker } from "../voice/voice-performance";
import {
  VoiceSession,
  type VoiceSessionTransport,
} from "../voice/voice-session";

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface VoiceSocketRouteOptions {
  readonly chatService: ShivaChatService;
  readonly asrProvider: ASRProvider;
  readonly ttsProvider: TTSProvider;
  readonly playbackCoordinator?: VoicePlaybackCoordinator;
  readonly performance?: VoicePerformanceTracker;
  readonly chunker?: StreamingSpeechChunkerOptions;
  readonly maxCapturedAudioBytes?: number;
}

/**
 * The single realtime voice endpoint. One upgraded connection carries control
 * JSON both ways plus microphone and speech audio as binary frames.
 */
export function registerVoiceSocketRoute(
  app: FastifyInstance,
  options: VoiceSocketRouteOptions,
): void {
  app.route({
    method: "GET",
    url: "/voice/chat",
    handler: (_request, reply) =>
      reply.status(426).header("upgrade", "websocket").send({
        error: {
          code: "UPGRADE_REQUIRED",
          message: "The voice endpoint requires a WebSocket upgrade.",
        },
      }),
    wsHandler: (socket, request) => {
      const session = new VoiceSession({
        transport: createTransport(socket),
        chatService: options.chatService,
        asrProvider: options.asrProvider,
        ttsProvider: options.ttsProvider,
        logger: request.log,
        ...(options.playbackCoordinator
          ? { playbackCoordinator: options.playbackCoordinator }
          : {}),
        ...(options.performance ? { performance: options.performance } : {}),
        ...(options.chunker ? { chunker: options.chunker } : {}),
        ...(options.maxCapturedAudioBytes !== undefined
          ? { maxCapturedAudioBytes: options.maxCapturedAudioBytes }
          : {}),
      });

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
        const bytes = toBytes(data);
        if (isBinary) {
          session.handleBinaryMessage(bytes);
          return;
        }
        session.handleTextMessage(Buffer.from(bytes).toString("utf8"));
      });
      socket.on("error", (error) => {
        request.log.warn({ err: error }, "Voice socket failed");
      });
      socket.on("close", () => {
        clearInterval(heartbeat);
        session.close();
      });
    },
  });
}

function createTransport(socket: WebSocket): VoiceSessionTransport {
  return {
    get isOpen() {
      return socket.readyState === socket.OPEN;
    },
    sendControl(message) {
      socket.send(JSON.stringify(message));
    },
    sendAudio(frame) {
      socket.send(frame, { binary: true });
    },
    close() {
      socket.close(1000, "session_end");
    },
  };
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

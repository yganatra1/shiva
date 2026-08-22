import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import { createAgentRuntime } from "./agent/runtime.js";
import type { AgentOrchestratorPort } from "./agent/types.js";
import {
  registerChatRoute,
  registerVoiceChatDiagnosticRoute,
} from "./api/chat-route.js";
import { registerErrorHandling } from "./api/error-handler.js";
import { registerExecutionSettingsRoute } from "./api/execution-settings-route.js";
import { registerDeviceSocketRoute } from "./api/device-socket-route.js";
import { registerHealthRoute } from "./api/health-route.js";
import { registerVoiceRoutes } from "./api/voice-route.js";
import { registerVoiceSocketRoute } from "./api/voice-socket-route.js";
import type { AIProvider } from "./brain/ai-provider.js";
import type { EmbeddingProvider } from "./brain/embedding-provider.js";
import { OllamaEmbeddingProvider } from "./brain/ollama-embedding-provider.js";
import { OllamaProvider } from "./brain/ollama-provider.js";
import type { AppConfig } from "./config/environment.js";
import { createDatabase } from "./database/pool.js";
import { DeviceCommandDispatcher } from "./device/device-command-dispatcher.js";
import { MemoryExtractor } from "./memory/memory-extractor.js";
import { MemoryRanker } from "./memory/memory-ranker.js";
import { MemoryRepository } from "./memory/memory-repository.js";
import { MemoryRetriever } from "./memory/memory-retriever.js";
import { MemoryService } from "./memory/memory-service.js";
import type {
  MemoryExtractionEngine,
  MemoryRepositoryPort,
} from "./memory/types.js";
import type { ChatPerformanceLogSink } from "./observability/chat-performance.js";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
} from "./security/confirmation.js";
import {
  ExecutionStateService,
  InMemoryExecutionStateStore,
} from "./security/execution-state.js";
import {
  ExecutionStatusService,
  type ExecutionStatusPort,
} from "./security/execution-status.js";
import { ShivaChatService } from "./services/chat-service.js";
import { HttpASRProvider } from "./voice/http-asr-provider.js";
import { HttpTTSProvider } from "./voice/http-tts-provider.js";
import type { ASRProvider, TTSProvider } from "./voice/provider.js";
import { VoicePlaybackCoordinator } from "./voice/playback-coordinator.js";
import {
  formatVoicePerformanceLog,
  VoicePerformanceTracker,
  type VoicePerformanceLogSink,
} from "./voice/voice-performance.js";

/** Chat may include a base64 JPEG (~1.5M chars) for vision turns. */
const API_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const API_REQUEST_TIMEOUT_MS = 30_000;
const VOICE_SOCKET_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface AppOverrides {
  readonly provider?: AIProvider;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly repository?: MemoryRepositoryPort;
  readonly extractionEngine?: MemoryExtractionEngine;
  readonly performanceLogSink?: ChatPerformanceLogSink;
  readonly asrProvider?: ASRProvider;
  readonly ttsProvider?: TTSProvider;
  readonly voicePerformanceLogSink?: VoicePerformanceLogSink;
  readonly voicePlaybackCoordinator?: VoicePlaybackCoordinator;
  readonly agentOrchestrator?: AgentOrchestratorPort;
  readonly executionStatus?: ExecutionStatusPort;
  readonly deviceDispatcher?: DeviceCommandDispatcher;
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: API_BODY_LIMIT_BYTES,
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    logger: {
      level: config.nodeEnv === "development" ? "debug" : "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie"],
        censor: "[Redacted]",
      },
    },
  });

  const provider =
    overrides.provider ??
    new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      contextLength: config.contextLength,
      keepAlive: config.keepAlive,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
  const database = overrides.repository ? undefined : createDatabase(config);
  const repository =
    overrides.repository ?? new MemoryRepository(requiredDatabase(database));
  const embeddingProvider =
    overrides.embeddingProvider ??
    new OllamaEmbeddingProvider({
      baseUrl: config.ollamaUrl,
      model: config.embeddingModel,
      requestTimeoutMs: config.embeddingRequestTimeoutMs,
    });
  const extractionEngine =
    overrides.extractionEngine ??
    new MemoryExtractor(provider, (detail, message) => {
      app.log.warn(detail, message);
    });
  const asrProvider =
    overrides.asrProvider ??
    new HttpASRProvider({
      baseUrl: config.asrServiceUrl,
      requestTimeoutMs: config.asrRequestTimeoutMs,
    });
  const ttsProvider =
    overrides.ttsProvider ??
    new HttpTTSProvider({
      baseUrl: config.ttsServiceUrl,
      requestTimeoutMs: config.ttsRequestTimeoutMs,
    });
  const voicePerformance = config.performanceLogging
    ? new VoicePerformanceTracker(
        overrides.voicePerformanceLogSink ??
          ((entry) => {
            app.log.info(
              { shivaVoicePerformance: entry },
              formatVoicePerformanceLog(entry),
            );
          }),
      )
    : undefined;
  const voicePlaybackCoordinator =
    overrides.voicePlaybackCoordinator ?? new VoicePlaybackCoordinator();
  const memoryRetriever = new MemoryRetriever(
    repository,
    embeddingProvider,
    new MemoryRanker(),
    config.memoryRetrievalLimit,
  );
  const memoryService = new MemoryService(
    repository,
    embeddingProvider,
    extractionEngine,
  );
  const agentRuntime = database
    ? createAgentRuntime(
        database.db,
        provider,
        config,
        (error) => {
          app.log.error({ err: error }, "Agent audit finalization failed");
        },
        config.agentTraceLog ? consoleTrace : undefined,
      )
    : undefined;
  const agentOrchestrator =
    overrides.agentOrchestrator ?? agentRuntime?.orchestrator;
  const executionStatus =
    overrides.executionStatus ??
    agentRuntime?.executionStatus ??
    createInMemoryExecutionStatus(config);
  const deviceDispatcher =
    overrides.deviceDispatcher ??
    agentRuntime?.deviceDispatcher ??
    new DeviceCommandDispatcher();
  const chatService = new ShivaChatService({
    provider,
    repository,
    memoryRetriever,
    memoryService,
    userId: config.userId,
    userName: config.userName,
    timeZone: config.timeZone,
    workingMemoryMessageLimit: config.workingMemoryMessageLimit,
    ...(agentOrchestrator ? { agentOrchestrator } : {}),
    automaticMemoryGate: {
      waitUntilReady: async () =>
        (await voicePlaybackCoordinator.waitUntilAllIdle()) !== "closed",
      isClosed: () => voicePlaybackCoordinator.isClosed(),
    },
    onBackgroundError: (error) => {
      app.log.error({ err: error }, "Non-critical memory processing failed");
    },
  });

  app.addHook("preClose", async () => {
    voicePlaybackCoordinator.close();
  });
  app.addHook("onClose", async () => {
    await chatService.drainBackgroundMemory();
    if (database) {
      await database.pool.end();
    }
  });

  registerErrorHandling(app);
  registerHealthRoute(app, config);
  registerExecutionSettingsRoute(app, executionStatus);
  const chatRouteOptions = {
    performanceLogging: config.performanceLogging,
    ...(overrides.performanceLogSink
      ? { performanceLogSink: overrides.performanceLogSink }
      : {}),
  };
  registerChatRoute(app, chatService, chatRouteOptions);
  registerVoiceChatDiagnosticRoute(app, chatService, chatRouteOptions);
  registerVoiceRoutes(app, { asrProvider, ttsProvider });

  app.register(fastifyWebsocket, {
    options: { maxPayload: VOICE_SOCKET_MAX_FRAME_BYTES },
  });
  app.register(async (instance) => {
    registerVoiceSocketRoute(instance, {
      chatService,
      asrProvider,
      ttsProvider,
      playbackCoordinator: voicePlaybackCoordinator,
      ...(voicePerformance ? { performance: voicePerformance } : {}),
    });
    registerDeviceSocketRoute(instance, {
      dispatcher: deviceDispatcher,
      ...(config.deviceWsToken ? { authToken: config.deviceWsToken } : {}),
    });
  });

  return app;
}

function createInMemoryExecutionStatus(config: AppConfig): ExecutionStatusPort {
  const state = new ExecutionStateService(
    new InMemoryExecutionStateStore(),
    config.maxExecutionMode,
  );
  const confirmations = new ConfirmationService(
    new InMemoryConfirmationStore(),
    config.confirmationTtlMs,
  );
  return new ExecutionStatusService(state, confirmations, config.userId);
}

function requiredDatabase(
  database: ReturnType<typeof createDatabase> | undefined,
) {
  if (!database) {
    throw new Error("A database is required when no repository is provided.");
  }
  return database.db;
}

/**
 * Plain stdout output for SHIVA_AGENT_TRACE_LOG, deliberately not routed
 * through the pino logger: it depends on log level, redaction config, and
 * how output is being viewed, any of which can make a trace silently not
 * appear. console.log always goes straight to stdout, which is what every
 * common deployment (pm2, docker, a bare terminal) already captures.
 */
function consoleTrace(detail: Record<string, unknown>, message: string): void {
  console.log(`[SHIVA-TRACE] ${message}`);
  console.log(JSON.stringify(detail, null, 2));
}

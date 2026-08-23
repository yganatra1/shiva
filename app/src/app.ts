import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import { createAgentRuntime } from "./agent/runtime";
import type { AgentOrchestratorPort } from "./agent/types";
import {
  registerChatRoute,
  registerVoiceChatDiagnosticRoute,
} from "./api/chat-route";
import { registerErrorHandling } from "./api/error-handler";
import { registerExecutionSettingsRoute } from "./api/execution-settings-route";
import { registerDeviceSocketRoute } from "./api/device-socket-route";
import { registerHealthRoute } from "./api/health-route";
import { registerPeopleRoutes } from "./api/people-route";
import { registerVoiceRoutes } from "./api/voice-route";
import { registerVoiceSocketRoute } from "./api/voice-socket-route";
import type { AIProvider } from "./brain/ai-provider";
import type { EmbeddingProvider } from "./brain/embedding-provider";
import { OllamaEmbeddingProvider } from "./brain/ollama-embedding-provider";
import { OllamaProvider } from "./brain/ollama-provider";
import type { AppConfig } from "./config/environment";
import { createDatabase } from "./database/pool";
import { DeviceCommandDispatcher } from "./device/device-command-dispatcher";
import {
  FaceRecognitionService,
  type FaceRecognitionServiceOptions,
} from "./face/face-recognition-service";
import { HttpFaceProvider } from "./face/http-face-provider";
import type { FaceProvider } from "./face/provider";
import { MemoryExtractor } from "./memory/memory-extractor";
import { MemoryRanker } from "./memory/memory-ranker";
import { MemoryRepository } from "./memory/memory-repository";
import { MemoryRetriever } from "./memory/memory-retriever";
import { MemoryService } from "./memory/memory-service";
import type {
  MemoryExtractionEngine,
  MemoryRepositoryPort,
} from "./memory/types";
import type { ChatPerformanceLogSink } from "./observability/chat-performance";
import { DrizzlePeopleRepository } from "./people/people-repository";
import type { PeopleRepositoryPort } from "./people/types";
import {
  ConfirmationService,
  InMemoryConfirmationStore,
} from "./security/confirmation";
import {
  ExecutionStateService,
  InMemoryExecutionStateStore,
} from "./security/execution-state";
import {
  ExecutionStatusService,
  type ExecutionStatusPort,
} from "./security/execution-status";
import { ShivaChatService } from "./services/chat-service";
import { HttpASRProvider } from "./voice/http-asr-provider";
import { HttpTTSProvider } from "./voice/http-tts-provider";
import type { ASRProvider, TTSProvider } from "./voice/provider";
import { VoicePlaybackCoordinator } from "./voice/playback-coordinator";
import {
  formatVoicePerformanceLog,
  VoicePerformanceTracker,
  type VoicePerformanceLogSink,
} from "./voice/voice-performance";

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
  readonly faceProvider?: FaceProvider;
  readonly peopleRepository?: PeopleRepositoryPort;
  readonly faceRecognition?: FaceRecognitionService;
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
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-shiva-file-name",
        ],
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
  const faceProvider =
    overrides.faceProvider ??
    new HttpFaceProvider({
      baseUrl: config.faceServiceUrl,
      requestTimeoutMs: config.faceRequestTimeoutMs,
    });
  const peopleRepository =
    overrides.peopleRepository ??
    (database ? new DrizzlePeopleRepository(database.db) : undefined);
  const faceRecognition =
    overrides.faceRecognition ??
    (peopleRepository
      ? new FaceRecognitionService({
          repository: peopleRepository,
          provider: faceProvider,
          matchThreshold: config.faceMatchThreshold,
          enrollmentThreshold: config.faceEnrollmentThreshold,
          ambiguityMargin: config.faceAmbiguityMargin,
        } satisfies FaceRecognitionServiceOptions)
      : undefined);
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
        faceRecognition,
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
    ...(faceRecognition ? { faceRecognition } : {}),
    ...(agentOrchestrator ? { agentOrchestrator } : {}),
    automaticMemoryGate: {
      waitUntilReady: async () =>
        (await voicePlaybackCoordinator.waitUntilAllIdle()) !== "closed",
      isClosed: () => voicePlaybackCoordinator.isClosed(),
    },
    onBackgroundError: (error) => {
      app.log.error(
        { err: error },
        "Non-critical chat context or memory processing failed",
      );
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
  if (peopleRepository && faceRecognition) {
    registerPeopleRoutes(app, {
      repository: peopleRepository,
      recognition: faceRecognition,
      provider: faceProvider,
      userId: config.userId,
      userName: config.userName,
    });
  }

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

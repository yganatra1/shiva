import fastifyWebsocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import { createAgentRuntime } from "./agent/runtime";
import type { AgentOrchestratorPort } from "./agent/types";
import {
  registerChatRoute,
  registerVoiceChatDiagnosticRoute,
} from "./api/chat-route";
import { registerConversationsRoutes } from "./api/conversations-route";
import { registerErrorHandling } from "./api/error-handler";
import { registerExecutionSettingsRoute } from "./api/execution-settings-route";
import { registerDeviceSocketRelayRoute } from "./api/device-socket-relay-route";
import { registerHealthRoute } from "./api/health-route";
import { registerPeopleRoutes } from "./api/people-route";
import { registerTradingRoutes } from "./api/trading-route";
import { registerVoiceRoutes } from "./api/voice-route";
import { registerVoiceSocketRoute } from "./api/voice-socket-route";
import type { AIProvider } from "./brain/ai-provider";
import type { EmbeddingProvider } from "./brain/embedding-provider";
import { createChatProvider } from "./brain/chat-provider-factory";
import { OllamaEmbeddingProvider } from "./brain/ollama-embedding-provider";
import type { AppConfig } from "./config/environment";
import {
  CoreUpdateHub,
  registerCoreUpdateSocketRoute,
} from "./core/core-update-hub";
import type { CoreUpdateReplaySource } from "./core/core-update-replay";
import { createDatabase } from "./database/pool";
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
import { createSchedulerQueue, type SchedulerLogSink } from "./scheduler/pg-boss";
import { DrizzleSchedulerRepository } from "./scheduler/scheduler-repository";
import { SchedulerService } from "./scheduler/scheduler-service";
import { ScheduledCoreExecutor } from "./scheduler/scheduled-core-executor";
import { registerSchedulerInternalRoute } from "./scheduler/scheduler-api-route";
import { KiteClient } from "./tools/kite/client";
import { loadTradingConfigFromEnv } from "./trading/config";
import { KiteMarketDataProvider } from "./trading/market-data/kite-market-data-provider";
import { UnconfiguredMarketDataProvider } from "./trading/market-data/unconfigured-provider";
import { TradingScannerService } from "./trading/scanner/trading-scanner-service";
import { BreakoutVolumeStrategy } from "./trading/strategies/breakout-volume-strategy";
import { TrendMomentumStrategy } from "./trading/strategies/trend-momentum-strategy";
import { DrizzleTradingRepository } from "./trading/trading-repository";
import { TradingService } from "./trading/trading-service";
import { KiteInstrumentUniverseProvider } from "./trading/universe/kite-instrument-universe-provider";
import { StaticInstrumentUniverseProvider } from "./trading/universe/static-universe-provider";
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
  readonly coreUpdateHub?: CoreUpdateHub;
  readonly coreUpdateReplaySource?: CoreUpdateReplaySource;
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: API_BODY_LIMIT_BYTES,
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    logController: new LogController({ disableRequestLogging: true }),
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

  const provider = overrides.provider ?? createChatProvider(config);
  const database = overrides.repository ? undefined : createDatabase(config);
  const repository =
    overrides.repository ?? new MemoryRepository(requiredDatabase(database));
  const schedulerRepository = database
    ? new DrizzleSchedulerRepository(database.db)
    : undefined;
  const schedulerLogger = fastifySchedulerLogger(app);
  const schedulerQueue = schedulerRepository
    ? createSchedulerQueue({
        databaseUrl: config.databaseUrl,
        databaseSsl: config.databaseSsl,
        poolMax: config.schedulerDatabasePoolMax,
        monitorSchedules: false,
        applicationName: "shiva-api-scheduler-producer",
        logger: schedulerLogger,
      })
    : undefined;
  const schedulerService =
    schedulerRepository && schedulerQueue
      ? new SchedulerService({
          queue: schedulerQueue,
          repository: schedulerRepository,
          queueOptions: config.schedulerQueueOptions,
          logger: schedulerLogger,
        })
      : undefined;
  const tradingService =
    database && config.tradingApiToken
      ? (() => {
          const tradingConfig = loadTradingConfigFromEnv(process.env);
          const kiteClient =
            config.kiteApiKey && config.kiteAccessToken
              ? new KiteClient({
                  apiKey: config.kiteApiKey,
                  accessToken: config.kiteAccessToken,
                  ...(config.kiteBaseUrl ? { baseUrl: config.kiteBaseUrl } : {}),
                  requestTimeoutMs: config.kiteRequestTimeoutMs,
                })
              : undefined;
          app.log.info(
            kiteClient
              ? "Kite Connect configured — trading scans will fetch real market data."
              : "Kite Connect not configured — scans will not produce candidates until KITE_API_KEY/KITE_ACCESS_TOKEN are set.",
          );
          const universeProvider = kiteClient
            ? new KiteInstrumentUniverseProvider({
                client: kiteClient,
                exchange: "NSE",
                tradingsymbols: tradingConfig.staticUniverseSymbols,
              })
            : new StaticInstrumentUniverseProvider({
                symbols: tradingConfig.staticUniverseSymbols,
              });
          const benchmarkInstrument = {
            instrumentToken: 0,
            exchange: "INDICES",
            tradingsymbol: tradingConfig.benchmarkSymbol,
          };
          const scanner = new TradingScannerService({
            universeProvider,
            marketDataProvider: kiteClient
              ? new KiteMarketDataProvider({ client: kiteClient })
              : new UnconfiguredMarketDataProvider(),
            strategies: [TrendMomentumStrategy, BreakoutVolumeStrategy],
            config: tradingConfig,
            benchmarkInstrument,
          });
          return new TradingService({
            scanner,
            repository: new DrizzleTradingRepository(database.db),
          });
        })()
      : undefined;
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
  const coreUpdateHub =
    overrides.coreUpdateHub ??
    new CoreUpdateHub((error) => {
      app.log.warn(
        { err: error },
        "A chat update client failed without affecting Core processing",
      );
    });
  const agentRuntime = database
    ? createAgentRuntime(
        database.db,
        provider,
        embeddingProvider,
        config,
        repository,
        memoryService,
        coreUpdateHub,
        (error) => {
          app.log.error({ err: error }, "Agent audit finalization failed");
        },
        config.agentTraceLog ? consoleTrace : undefined,
        schedulerService,
      )
    : undefined;
  const agentOrchestrator =
    overrides.agentOrchestrator ?? agentRuntime?.orchestrator;
  const executionStatus =
    overrides.executionStatus ??
    agentRuntime?.executionStatus ??
    createInMemoryExecutionStatus(config);
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
    await agentRuntime?.close();
    await schedulerService?.stop();
  });
  app.addHook("onReady", async () => {
    await schedulerService?.start();
    await agentRuntime?.start();
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
  registerConversationsRoutes(app, {
    repository,
    userId: config.userId,
  });
  registerVoiceRoutes(app, { asrProvider, ttsProvider });
  if (
    schedulerRepository &&
    schedulerService &&
    config.schedulerToken
  ) {
    registerSchedulerInternalRoute(
      app,
      new ScheduledCoreExecutor({
        repository: schedulerRepository,
        chatService,
        updates: coreUpdateHub,
        configuredUserId: config.userId,
        logger: schedulerLogger,
        processingUncertainAfterMs:
          config.schedulerProcessingUncertainAfterMs,
      }),
      config.schedulerToken,
    );
  }
  if (tradingService && config.tradingApiToken) {
    registerTradingRoutes(app, {
      service: tradingService,
      token: config.tradingApiToken,
    });
  }
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
  const coreUpdateReplaySource =
    overrides.coreUpdateReplaySource ?? agentRuntime?.updateReplay;
  app.register(async (instance) => {
    registerVoiceSocketRoute(instance, {
      chatService,
      asrProvider,
      ttsProvider,
      playbackCoordinator: voicePlaybackCoordinator,
      coreUpdateHub,
      ...(coreUpdateReplaySource ? { coreUpdateReplaySource } : {}),
      ...(voicePerformance ? { performance: voicePerformance } : {}),
    });
    registerCoreUpdateSocketRoute(
      instance,
      coreUpdateHub,
      coreUpdateReplaySource,
    );
    registerDeviceSocketRelayRoute(instance, {
      deviceAgentUrl: config.deviceAgentUrl,
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

function fastifySchedulerLogger(app: FastifyInstance): SchedulerLogSink {
  return {
    info(detail, message) {
      app.log.info(detail, message);
    },
    warn(detail, message) {
      app.log.warn(detail, message);
    },
    error(detail, message) {
      app.log.error(detail, message);
    },
  };
}

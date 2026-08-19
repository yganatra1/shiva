import Fastify, { type FastifyInstance } from "fastify";

import { registerChatRoute } from "./api/chat-route.js";
import { registerErrorHandling } from "./api/error-handler.js";
import { registerHealthRoute } from "./api/health-route.js";
import type { AIProvider } from "./brain/ai-provider.js";
import type { EmbeddingProvider } from "./brain/embedding-provider.js";
import { OllamaEmbeddingProvider } from "./brain/ollama-embedding-provider.js";
import { OllamaProvider } from "./brain/ollama-provider.js";
import type { AppConfig } from "./config/environment.js";
import { createDatabase } from "./database/pool.js";
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
import { ShivaChatService } from "./services/chat-service.js";

const API_BODY_LIMIT_BYTES = 256 * 1024;
const API_REQUEST_TIMEOUT_MS = 30_000;

export interface AppOverrides {
  readonly provider?: AIProvider;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly repository?: MemoryRepositoryPort;
  readonly extractionEngine?: MemoryExtractionEngine;
  readonly performanceLogSink?: ChatPerformanceLogSink;
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
    overrides.extractionEngine ?? new MemoryExtractor(provider);
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
  const chatService = new ShivaChatService({
    provider,
    repository,
    memoryRetriever,
    memoryService,
    userId: config.userId,
    userName: config.userName,
    workingMemoryMessageLimit: config.workingMemoryMessageLimit,
    onBackgroundError: (error) => {
      app.log.error({ err: error }, "Non-critical memory processing failed");
    },
  });

  if (database) {
    app.addHook("onClose", async () => database.pool.end());
  }

  registerErrorHandling(app);
  registerHealthRoute(app, config);
  registerChatRoute(app, chatService, {
    performanceLogging: config.performanceLogging,
    ...(overrides.performanceLogSink
      ? { performanceLogSink: overrides.performanceLogSink }
      : {}),
  });

  return app;
}

function requiredDatabase(
  database: ReturnType<typeof createDatabase> | undefined,
) {
  if (!database) {
    throw new Error("A database is required when no repository is provided.");
  }
  return database.db;
}

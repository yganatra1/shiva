import Fastify, { type FastifyInstance } from "fastify";

import { registerChatRoute } from "./api/chat-route.js";
import { registerErrorHandling } from "./api/error-handler.js";
import { registerHealthRoute } from "./api/health-route.js";
import type { AIProvider } from "./brain/ai-provider.js";
import { OllamaProvider } from "./brain/ollama-provider.js";
import type { AppConfig } from "./config/environment.js";
import { ShivaChatService } from "./services/chat-service.js";

const API_BODY_LIMIT_BYTES = 256 * 1024;
const API_REQUEST_TIMEOUT_MS = 30_000;

export function createApp(
  config: AppConfig,
  providerOverride?: AIProvider,
): FastifyInstance {
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
    providerOverride ??
    new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      contextLength: config.contextLength,
      keepAlive: config.keepAlive,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
  const chatService = new ShivaChatService(provider);

  registerErrorHandling(app);
  registerHealthRoute(app, config);
  registerChatRoute(app, chatService);

  return app;
}

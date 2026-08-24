import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { AIProvider } from "../../brain/ai-provider";
import { OllamaProvider } from "../../brain/ollama-provider";
import type { DeviceAgentConfig } from "../../config/environment";
import { DeviceCommandDispatcher } from "./device-command-dispatcher";
import { registerDeviceSocketRoute } from "./device-socket-route";
import { registerDispatchRoute } from "./dispatch-route";
import { runDeviceAgentGoal } from "./device-agent-loop";
import { ShivaDeviceAgentPlanner } from "./device-agent-planner";
import type { DeviceAgentPlanner } from "./device-agent-types";

/** A delegated goal can run many tool calls end to end — minutes, not seconds. */
const API_REQUEST_TIMEOUT_MS = 600_000;
const API_BODY_LIMIT_BYTES = 64 * 1024;

const delegateBodySchema = z
  .object({
    goal: z.string().trim().min(1).max(2_000),
  })
  .strict();

export interface DeviceAgentAppOverrides {
  readonly dispatcher?: DeviceCommandDispatcher;
  readonly provider?: AIProvider;
  readonly planner?: DeviceAgentPlanner;
}

export function createDeviceAgentApp(
  config: DeviceAgentConfig,
  overrides: DeviceAgentAppOverrides = {},
): FastifyInstance {
  const app = Fastify({
    bodyLimit: API_BODY_LIMIT_BYTES,
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    logger: {
      level: config.nodeEnv === "development" ? "debug" : "info",
    },
  });

  const dispatcher = overrides.dispatcher ?? new DeviceCommandDispatcher();
  const provider =
    overrides.provider ??
    new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      contextLength: config.contextLength,
      keepAlive: config.keepAlive,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
  const planner = overrides.planner ?? new ShivaDeviceAgentPlanner(provider);

  app.get("/health", () => ({ status: "ok", name: "shiva-device-agent" }));
  registerDispatchRoute(app, { dispatcher });

  app.post("/v1/delegate", async (request, reply) => {
    const parsed = delegateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_DELEGATE_REQUEST",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        },
      });
    }
    if (!dispatcher.isConnected()) {
      return reply.status(503).send({
        error: {
          code: "DEVICE_NOT_CONNECTED",
          message: "No phone is currently connected — the goal was not attempted.",
        },
      });
    }

    const controller = new AbortController();
    const abortOnPrematureClose = (): void => {
      if (!reply.raw.writableEnded) {
        controller.abort();
      }
    };
    reply.raw.once("close", abortOnPrematureClose);
    if (reply.raw.destroyed && !reply.raw.writableEnded) {
      controller.abort();
    }
    try {
      const result = await runDeviceAgentGoal(parsed.data.goal, dispatcher, planner, {
        maxSteps: config.deviceAgentMaxSteps,
        signal: controller.signal,
      });
      return reply.status(200).send(result);
    } finally {
      reply.raw.removeListener("close", abortOnPrematureClose);
    }
  });

  app.register(fastifyWebsocket);
  app.register(async (instance) => {
    registerDeviceSocketRoute(instance, {
      dispatcher,
      ...(config.deviceWsToken ? { authToken: config.deviceWsToken } : {}),
    });
  });

  return app;
}

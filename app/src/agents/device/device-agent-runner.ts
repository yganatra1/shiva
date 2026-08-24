import type { FastifyInstance } from "fastify";

import { OllamaProvider } from "../../brain/ollama-provider";
import {
  ConfigurationError,
  loadDeviceAgentConfig,
} from "../../config/environment";
import { AgentWorker } from "../shared/agent-worker";
import { RedisAgentTransport } from "../shared/redis-agent-transport";
import { createDeviceAgentApp } from "./device-agent-app";
import { ShivaDeviceAgentPlanner } from "./device-agent-planner";
import { createDeviceAgentTaskHandler } from "./device-agent-task-handler";
import { DeviceCommandDispatcher } from "./device-command-dispatcher";

async function start(): Promise<void> {
  let app: FastifyInstance | undefined;

  try {
    const config = loadDeviceAgentConfig();
    const dispatcher = new DeviceCommandDispatcher();
    const provider = new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      contextLength: config.contextLength,
      keepAlive: config.keepAlive,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
    const planner = new ShivaDeviceAgentPlanner(provider);
    const transport = new RedisAgentTransport({ redisUrl: config.redisUrl });
    const worker = new AgentWorker({
      agentId: "device-agent",
      transport,
      maxAttempts: config.agentMaxDeliveryAttempts,
      reclaimIdleMs: config.agentReclaimIdleMs,
      heartbeatTtlMs: config.agentHeartbeatTtlSeconds * 1_000,
      heartbeatIntervalMs: Math.floor(
        (config.agentHeartbeatTtlSeconds * 1_000) / 3,
      ),
      onError: (error) => {
        app?.log.error({ err: error }, "Device agent worker failed");
      },
      handler: createDeviceAgentTaskHandler({
        dispatcher,
        planner,
        maxSteps: config.deviceAgentMaxSteps,
        ...(config.deviceAgentMockCallOutcome
          ? { mockCallOutcome: config.deviceAgentMockCallOutcome }
          : {}),
      }),
    });
    app = createDeviceAgentApp(config, { dispatcher, provider, planner });
    if (config.deviceAgentMockCallOutcome) {
      app.log.warn(
        { simulatedCallOutcome: config.deviceAgentMockCallOutcome },
        "Device Agent phone-call mock mode is enabled; no calls will be placed",
      );
    }
    app.addHook("onReady", async () => {
      await transport.connect();
      void worker.start().catch((error: unknown) => {
        app?.log.error({ err: error }, "Device agent worker stopped");
        process.exitCode = 1;
        void app?.close();
      });
    });
    app.addHook("preClose", async () => {
      await worker.stop();
      await transport.close();
    });
    registerShutdownHandlers(app);

    await app.listen({ port: config.deviceAgentPort, host: config.deviceAgentHost });
  } catch (error: unknown) {
    if (app) {
      app.log.error({ err: error }, "shiva-device-agent failed to start");
      await app.close().catch(() => undefined);
    } else if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error("shiva-device-agent failed to start due to an unexpected error.");
    }

    process.exitCode = 1;
  }
}

function registerShutdownHandlers(app: FastifyInstance): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, "Shutting down shiva-device-agent");

    try {
      await app.close();
    } catch (error: unknown) {
      app.log.error({ err: error }, "shiva-device-agent failed to shut down cleanly");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void start();

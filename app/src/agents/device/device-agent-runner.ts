import type { FastifyInstance } from "fastify";

import { ConfigurationError, loadConfig } from "../../config/environment";
import { createDeviceAgentApp } from "./device-agent-app";

async function start(): Promise<void> {
  let app: FastifyInstance | undefined;

  try {
    const config = loadConfig();
    app = createDeviceAgentApp(config);
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

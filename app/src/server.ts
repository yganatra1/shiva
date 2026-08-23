import type { FastifyInstance } from "fastify";

import { createApp } from "./app";
import { ConfigurationError, loadConfig } from "./config/environment";

async function start(): Promise<void> {
  let app: FastifyInstance | undefined;

  try {
    const config = loadConfig();
    app = createApp(config);
    registerShutdownHandlers(app);

    await app.listen({ port: config.port, host: config.host });
  } catch (error: unknown) {
    if (app) {
      app.log.error({ err: error }, "Shiva failed to start");
      await app.close().catch(() => undefined);
    } else if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error("Shiva failed to start due to an unexpected error.");
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
    app.log.info({ signal }, "Shutting down Shiva");

    try {
      await app.close();
    } catch (error: unknown) {
      app.log.error({ err: error }, "Shiva failed to shut down cleanly");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void start();

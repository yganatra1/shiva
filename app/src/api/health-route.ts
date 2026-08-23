import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config/environment";

export function registerHealthRoute(
  app: FastifyInstance,
  config: AppConfig,
): void {
  app.get("/health", () => ({
    status: "ok",
    name: "Shiva",
    version: "0.3.0",
    model: config.model,
  }));
}

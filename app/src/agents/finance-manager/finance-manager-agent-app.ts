import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { FinanceManagerAgentConfig } from "../../config/environment";
import type { MutualFundDataProvider } from "../../finance/types";

export function createFinanceManagerAgentApp(
  config: FinanceManagerAgentConfig,
  provider: MutualFundDataProvider,
): FastifyInstance {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    requestTimeout: 5_000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.nodeEnv === "development" ? "debug" : "info",
    },
  });

  let lastProbe:
    | { readonly at: number; readonly reachable: boolean }
    | undefined;

  app.get("/health", async () => {
    const reachable = await cachedProbe();
    return {
      status: "ok",
      name: "shiva-finance-manager-agent",
      provider: "mfapi",
      providerReachable: reachable,
    };
  });

  async function cachedProbe(): Promise<boolean> {
    const now = Date.now();
    if (lastProbe && now - lastProbe.at < 60_000) return lastProbe.reachable;
    const reachable = provider.probe ? await provider.probe() : true;
    lastProbe = { at: now, reachable };
    return reachable;
  }

  return app;
}

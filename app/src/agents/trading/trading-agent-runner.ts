import { AgentLoop } from "../../agent/agent-loop";
import { ShivaAgentPlanner } from "../../agent/planner";
import { createChatProvider } from "../../brain/chat-provider-factory";
import {
  ConfigurationError,
  loadTradingAgentConfig,
} from "../../config/environment";
import { createDatabase } from "../../database/pool";
import { SkillExecutor } from "../../skills/executor";
import { registerTradingSkills } from "../../skills/trading/register";
import { SkillRegistry } from "../../skills/registry";
import { KiteClient } from "../../tools/kite/client";
import { KiteMarketDataProvider } from "../../trading/market-data/kite-market-data-provider";
import { UnconfiguredMarketDataProvider } from "../../trading/market-data/unconfigured-provider";
import { TradingScannerService } from "../../trading/scanner/trading-scanner-service";
import { BreakoutVolumeStrategy } from "../../trading/strategies/breakout-volume-strategy";
import { TrendMomentumStrategy } from "../../trading/strategies/trend-momentum-strategy";
import { DrizzleTradingRepository } from "../../trading/trading-repository";
import { TradingService } from "../../trading/trading-service";
import { KiteInstrumentUniverseProvider } from "../../trading/universe/kite-instrument-universe-provider";
import { StaticInstrumentUniverseProvider } from "../../trading/universe/static-universe-provider";
import { AgentWorker } from "../shared/agent-worker";
import { RedisAgentTransport } from "../shared/redis-agent-transport";
import { CoreAuthorizedAgentExecutionPolicy } from "./core-authorized-execution-policy";
import { createTradingAgentTaskHandler } from "./trading-agent-task-handler";
import { TRADING_AGENT_DOMAIN_RULES } from "./trading-planner-rules";

async function start(): Promise<void> {
  let closeTransport: (() => Promise<void>) | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    const config = loadTradingAgentConfig();
    const provider = createChatProvider(config);

    const database = createDatabase({
      databaseUrl: config.databaseUrl,
      databasePoolMax: config.databasePoolMax,
      databaseSsl: config.databaseSsl,
    });
    closeDatabase = () => database.pool.end();

    const kiteClient =
      config.kiteApiKey && config.kiteAccessToken
        ? new KiteClient({
            apiKey: config.kiteApiKey,
            accessToken: config.kiteAccessToken,
            ...(config.kiteBaseUrl ? { baseUrl: config.kiteBaseUrl } : {}),
            requestTimeoutMs: config.kiteRequestTimeoutMs,
          })
        : undefined;
    if (kiteClient) {
      console.info("Kite Connect configured — trading scans will fetch real market data.");
    } else {
      console.info(
        "Kite Connect not configured — scans will not produce candidates until KITE_API_KEY/KITE_ACCESS_TOKEN are set.",
      );
    }
    const universeProvider = kiteClient
      ? new KiteInstrumentUniverseProvider({
          client: kiteClient,
          exchange: "NSE",
          tradingsymbols: config.trading.staticUniverseSymbols,
        })
      : new StaticInstrumentUniverseProvider({
          symbols: config.trading.staticUniverseSymbols,
        });
    const scanner = new TradingScannerService({
      universeProvider,
      marketDataProvider: kiteClient
        ? new KiteMarketDataProvider({ client: kiteClient })
        : new UnconfiguredMarketDataProvider(),
      strategies: [TrendMomentumStrategy, BreakoutVolumeStrategy],
      config: config.trading,
      benchmarkInstrument: {
        instrumentToken: 0,
        exchange: "INDICES",
        tradingsymbol: config.trading.benchmarkSymbol,
      },
    });
    const tradingService = new TradingService({
      scanner,
      repository: new DrizzleTradingRepository(database.db),
    });

    const registry = new SkillRegistry();
    registerTradingSkills(registry, tradingService, kiteClient);
    const reportError = (error: unknown): void => {
      console.error("Trading Agent error", error);
    };
    const executor = new SkillExecutor(
      registry,
      new CoreAuthorizedAgentExecutionPolicy(),
    );
    const loop = new AgentLoop(
      new ShivaAgentPlanner(provider, undefined, {
        role: "agent",
        domainRules: TRADING_AGENT_DOMAIN_RULES,
      }),
      executor,
      registry,
      config.agentMaxSteps,
      undefined,
      undefined,
      undefined,
      undefined,
      reportError,
      config.agentRequestTimeoutMs,
    );
    const transport = new RedisAgentTransport({
      redisUrl: config.redisUrl,
      onRedisError: reportError,
    });
    closeTransport = () => transport.close();
    await transport.connect();
    const worker = new AgentWorker({
      agentId: "trading-agent",
      transport,
      maxAttempts: config.agentMaxDeliveryAttempts,
      reclaimIdleMs: config.agentReclaimIdleMs,
      heartbeatTtlMs: config.agentHeartbeatTtlSeconds * 1_000,
      heartbeatIntervalMs: Math.floor(
        (config.agentHeartbeatTtlSeconds * 1_000) / 3,
      ),
      onError: reportError,
      handler: createTradingAgentTaskHandler({
        loop,
        userId: config.userId,
        userName: config.userName,
        timeZone: config.timeZone,
      }),
    });
    const shutdownController = new AbortController();
    registerShutdownHandlers(shutdownController);
    console.info("shiva-trading-agent started");
    await worker.start(shutdownController.signal);
    await worker.stop();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error("shiva-trading-agent failed", error);
    }
    process.exitCode = 1;
  } finally {
    await closeTransport?.().catch(() => undefined);
    await closeDatabase?.().catch(() => undefined);
  }
}

function registerShutdownHandlers(controller: AbortController): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void start();

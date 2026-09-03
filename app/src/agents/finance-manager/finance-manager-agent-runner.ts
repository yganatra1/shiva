import type { FastifyInstance } from "fastify";

import { AgentLoop } from "../../agent/agent-loop";
import { ShivaAgentPlanner } from "../../agent/planner";
import { createChatProvider } from "../../brain/chat-provider-factory";
import {
  ConfigurationError,
  loadFinanceManagerAgentConfig,
} from "../../config/environment";
import { createDatabase } from "../../database/pool";
import { consoleFinanceLogger } from "../../finance/logging";
import { DrizzleMutualFundRepository } from "../../finance/persistence/drizzle-mutual-fund-repository";
import { MfApiClient } from "../../finance/providers/mfapi.client";
import { MfApiMutualFundProvider } from "../../finance/providers/mfapi-provider";
import { MutualFundAnalysisService } from "../../finance/services/mutual-fund-analysis.service";
import { MutualFundRankingService } from "../../finance/services/mutual-fund-ranking.service";
import { MutualFundService } from "../../finance/services/mutual-fund.service";
import { registerFinanceManagerSkills } from "../../skills/finance-manager/register";
import { SkillExecutor } from "../../skills/executor";
import { SkillRegistry } from "../../skills/registry";
import { CoreAuthorizedAgentExecutionPolicy } from "../google/core-authorized-execution-policy";
import { AgentWorker } from "../shared/agent-worker";
import { RedisAgentTransport } from "../shared/redis-agent-transport";
import { createFinanceManagerAgentApp } from "./finance-manager-agent-app";
import { createFinanceManagerAgentTaskHandler } from "./finance-manager-agent-task-handler";
import { FINANCE_MANAGER_DOMAIN_RULES } from "./finance-manager-planner-rules";

async function start(): Promise<void> {
  let app: FastifyInstance | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;

  try {
    const config = loadFinanceManagerAgentConfig();
    const database = createDatabase(config);
    closeDatabase = () => database.pool.end();
    const logger = consoleFinanceLogger();
    const client = new MfApiClient({
      baseUrl: config.financeMfapiBaseUrl,
      timeoutMs: config.financeMfapiTimeoutMs,
      maxRetries: config.financeMfapiMaxRetries,
    });
    const provider = new MfApiMutualFundProvider(client, logger);
    const repository = new DrizzleMutualFundRepository(database.db);
    const funds = new MutualFundService({
      provider,
      repository,
      logger,
      listCacheTtlMs: config.financeMfapiCacheTtlSeconds * 1000,
      maxConcurrency: config.financeMfapiMaxConcurrency,
    });
    const analysis = new MutualFundAnalysisService({
      funds,
      repository,
      logger,
      riskFreeRate: config.financeRiskFreeRate,
      riskFreeRateSource: config.financeRiskFreeRateSource,
      maxConcurrency: config.financeMfapiMaxConcurrency,
    });
    const ranking = new MutualFundRankingService(
      funds,
      analysis,
      logger,
      config.financeMfapiMaxConcurrency,
    );
    const skillRegistry = new SkillRegistry();
    registerFinanceManagerSkills(skillRegistry, funds, analysis, ranking);
    const reportError = (error: unknown): void => {
      app?.log.error({ err: error }, "Finance Manager Agent error");
      if (!app) console.error("Finance Manager Agent error", error);
    };
    const executor = new SkillExecutor(
      skillRegistry,
      new CoreAuthorizedAgentExecutionPolicy(),
    );
    const loop = new AgentLoop(
      new ShivaAgentPlanner(createChatProvider(config), undefined, {
        role: "agent",
        domainRules: FINANCE_MANAGER_DOMAIN_RULES,
      }),
      executor,
      skillRegistry,
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
    const worker = new AgentWorker({
      agentId: "finance-manager-agent",
      transport,
      maxAttempts: config.agentMaxDeliveryAttempts,
      reclaimIdleMs: config.agentReclaimIdleMs,
      heartbeatTtlMs: config.agentHeartbeatTtlSeconds * 1_000,
      heartbeatIntervalMs: Math.floor(
        (config.agentHeartbeatTtlSeconds * 1_000) / 3,
      ),
      onError: reportError,
      handler: createFinanceManagerAgentTaskHandler({
        loop,
        userId: config.userId,
        userName: config.userName,
        timeZone: config.timeZone,
      }),
    });
    app = createFinanceManagerAgentApp(config, provider);
    app.addHook("onReady", async () => {
      await transport.connect();
      void worker.start().catch((error: unknown) => {
        reportError(error);
        process.exitCode = 1;
        void app?.close();
      });
    });
    app.addHook("preClose", async () => {
      await worker.stop();
      await transport.close();
      await closeDatabase?.();
      closeDatabase = undefined;
    });
    registerShutdownHandlers(app);
    console.info("shiva-finance-manager-agent started");
    await app.listen({
      port: config.financeManagerAgentPort,
      host: config.financeManagerAgentHost,
    });
  } catch (error: unknown) {
    if (app) {
      app.log.error({ err: error }, "shiva-finance-manager-agent failed to start");
      await app.close().catch(() => undefined);
    } else if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error("shiva-finance-manager-agent failed", error);
    }
    process.exitCode = 1;
    await closeDatabase?.().catch(() => undefined);
  }
}

function registerShutdownHandlers(app: FastifyInstance): void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Shutting down shiva-finance-manager-agent");
    try {
      await app.close();
    } catch (error: unknown) {
      app.log.error(
        { err: error },
        "shiva-finance-manager-agent failed to shut down cleanly",
      );
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void start();

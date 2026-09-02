import { AgentLoop } from "../../agent/agent-loop";
import { ShivaAgentPlanner } from "../../agent/planner";
import { createChatProvider } from "../../brain/chat-provider-factory";
import {
  ConfigurationError,
  loadDeveloperAgentConfig,
} from "../../config/environment";
import { registerDeveloperSkills } from "../../skills/developer/register";
import { SkillExecutor } from "../../skills/executor";
import { SkillRegistry } from "../../skills/registry";
import { CoreAuthorizedAgentExecutionPolicy } from "../google/core-authorized-execution-policy";
import { AgentWorker } from "../shared/agent-worker";
import { RedisAgentTransport } from "../shared/redis-agent-transport";
import { createDeveloperAgentTaskHandler } from "./developer-agent-task-handler";
import { DEVELOPER_AGENT_DOMAIN_RULES } from "./developer-planner-rules";

async function start(): Promise<void> {
  let closeTransport: (() => Promise<void>) | undefined;
  try {
    const config = loadDeveloperAgentConfig();
    const provider = createChatProvider(config);
    const registry = new SkillRegistry();
    registerDeveloperSkills(registry, config);
    const reportError = (error: unknown): void => {
      console.error("Developer Agent error", error);
    };
    const executor = new SkillExecutor(
      registry,
      new CoreAuthorizedAgentExecutionPolicy(),
    );
    const loop = new AgentLoop(
      new ShivaAgentPlanner(provider, undefined, {
        role: "agent",
        domainRules: DEVELOPER_AGENT_DOMAIN_RULES,
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
      agentId: "developer-agent",
      transport,
      maxAttempts: config.agentMaxDeliveryAttempts,
      reclaimIdleMs: config.agentReclaimIdleMs,
      heartbeatTtlMs: config.agentHeartbeatTtlSeconds * 1_000,
      heartbeatIntervalMs: Math.floor(
        (config.agentHeartbeatTtlSeconds * 1_000) / 3,
      ),
      onError: reportError,
      handler: createDeveloperAgentTaskHandler({
        loop,
        userId: config.userId,
        userName: config.userName,
        timeZone: config.timeZone,
      }),
    });
    const shutdownController = new AbortController();
    registerShutdownHandlers(shutdownController);
    console.info("shiva-developer-agent started");
    await worker.start(shutdownController.signal);
    await worker.stop();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error("shiva-developer-agent failed", error);
    }
    process.exitCode = 1;
  } finally {
    await closeTransport?.().catch(() => undefined);
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

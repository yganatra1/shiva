import { AgentLoop } from "../../agent/agent-loop";
import { ShivaAgentPlanner } from "../../agent/planner";
import { OllamaProvider } from "../../brain/ollama-provider";
import {
  ConfigurationError,
  loadGoogleAgentConfig,
} from "../../config/environment";
import { SkillExecutor } from "../../skills/executor";
import { registerGoogleSkills } from "../../skills/google/register";
import { SkillRegistry } from "../../skills/registry";
import { AgentWorker } from "../shared/agent-worker";
import { RedisAgentTransport } from "../shared/redis-agent-transport";
import { CoreAuthorizedAgentExecutionPolicy } from "./core-authorized-execution-policy";
import { createGoogleAgentTaskHandler } from "./google-agent-task-handler";
import { GOOGLE_AGENT_DOMAIN_RULES } from "./google-planner-rules";

async function start(): Promise<void> {
  let closeTransport: (() => Promise<void>) | undefined;
  try {
    const config = loadGoogleAgentConfig();
    const provider = new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      contextLength: config.contextLength,
      keepAlive: config.keepAlive,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
    const registry = new SkillRegistry();
    registerGoogleSkills(registry, config);
    const reportError = (error: unknown): void => {
      console.error("Google Agent error", error);
    };
    const executor = new SkillExecutor(
      registry,
      new CoreAuthorizedAgentExecutionPolicy(),
    );
    const loop = new AgentLoop(
      new ShivaAgentPlanner(provider, undefined, {
        role: "agent",
        domainRules: GOOGLE_AGENT_DOMAIN_RULES,
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
    const allowedSkills = registry.list().map((skill) => skill.name);
    const transport = new RedisAgentTransport({
      redisUrl: config.redisUrl,
      onRedisError: reportError,
    });
    closeTransport = () => transport.close();
    await transport.connect();
    const worker = new AgentWorker({
      agentId: "google-agent",
      transport,
      maxAttempts: config.agentMaxDeliveryAttempts,
      reclaimIdleMs: config.agentReclaimIdleMs,
      heartbeatTtlMs: config.agentHeartbeatTtlSeconds * 1_000,
      heartbeatIntervalMs: Math.floor(
        (config.agentHeartbeatTtlSeconds * 1_000) / 3,
      ),
      onError: reportError,
      handler: createGoogleAgentTaskHandler({
        loop,
        userId: config.userId,
        userName: config.userName,
        timeZone: config.timeZone,
        allowedSkills,
      }),
    });
    const shutdownController = new AbortController();
    registerShutdownHandlers(shutdownController);
    console.info("shiva-google-agent started");
    await worker.start(shutdownController.signal);
    await worker.stop();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error("shiva-google-agent failed", error);
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

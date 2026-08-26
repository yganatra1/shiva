import { AgentTaskDispatcher } from "../agents/agent-task-dispatcher";
import { AgentRegistry } from "../agents/agent-registry";
import { DrizzleOrchestrationRepository } from "../agents/orchestration-repository";
import { RedisAgentTransport } from "../agents/shared/redis-agent-transport";
import type { AIProvider } from "../brain/ai-provider";
import type { EmbeddingProvider } from "../brain/embedding-provider";
import type { AppConfig } from "../config/environment";
import type { ShivaDatabase } from "../database/pool";
import type { MemoryService } from "../memory/memory-service";
import type { MemoryRepositoryPort } from "../memory/types";
import { CoreAgentResponseProcessor } from "../core/agent-response-processor";
import { AgentReliabilitySupervisor } from "../core/agent-reliability-supervisor";
import type { CoreUpdatePublisher } from "../core/core-update-hub";
import {
  DrizzleCoreUpdateReplaySource,
  type CoreUpdateReplaySource,
} from "../core/core-update-replay";
import { DrizzlePeopleRepository } from "../people/people-repository";
import {
  ConfirmationService,
  DrizzleConfirmationStore,
} from "../security/confirmation";
import {
  DrizzleExecutionStateStore,
  ExecutionStateService,
} from "../security/execution-state";
import { ExecutionStatusService } from "../security/execution-status";
import { ExecutionPolicyEngine } from "../security/policy-engine";
import { SkillExecutor } from "../skills/executor";
import { registerExecutionControlSkills } from "../skills/execution-control/register";
import { registerAgentSkills } from "../skills/agents/register";
import { registerCoreSkills } from "../skills/core/register";
import { registerMemorySkills } from "../skills/memory/register";
import { registerSystemSkills } from "../skills/system/register";
import { registerSchedulerSkills } from "../skills/scheduler/register";
import { registerPeopleSkills } from "../skills/people/register";
import { registerWebSkills } from "../skills/web/register";
import { SkillRegistry } from "../skills/registry";
import { AgentLoop } from "./agent-loop";
import { AgentAuditRepository } from "./audit";
import { ShivaOrchestrator } from "./orchestrator";
import { ShivaAgentPlanner, type AgentTraceLogger } from "./planner";
import type { AgentOrchestratorPort } from "./types";
import type { SchedulerService } from "../scheduler/scheduler-service";

export interface AgentRuntime {
  readonly orchestrator: AgentOrchestratorPort;
  readonly executionStatus: ExecutionStatusService;
  readonly updateReplay: CoreUpdateReplaySource;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createAgentRuntime(
  database: ShivaDatabase,
  provider: AIProvider,
  embeddingProvider: EmbeddingProvider,
  config: AppConfig,
  repository: MemoryRepositoryPort,
  memoryService: MemoryService,
  updates: CoreUpdatePublisher,
  onAuditError: (error: unknown) => void = () => {},
  onTrace?: AgentTraceLogger,
  scheduler?: Pick<
    SchedulerService,
    "create" | "update" | "delete" | "pause" | "resume" | "list" | "get"
  >,
): AgentRuntime {
  // Google tools and their OAuth credentials live only in google-agent. Core
  // advertises that worker through delegate_to_agent and never executes an
  // account operation in-process.
  const registry = new SkillRegistry();
  const executionState = new ExecutionStateService(
    new DrizzleExecutionStateStore(database),
    config.maxExecutionMode,
  );
  const orchestrationRepository = new DrizzleOrchestrationRepository(database);
  const confirmations = new ConfirmationService(
    new DrizzleConfirmationStore(database),
    config.confirmationTtlMs,
    undefined,
    async ({ confirmation, now }) => {
      const origin = confirmation.originContext;
      if (!origin.orchestrationRequestId || !origin.agentResponseId) return;
      await orchestrationRepository.completeRequestAfterConfirmation({
        requestId: origin.orchestrationRequestId,
        responseId: origin.agentResponseId,
        now,
      });
    },
  );
  registerExecutionControlSkills(registry, executionState, confirmations);
  registerCoreSkills(registry);
  registerSystemSkills(registry);
  // record_expense/expense_report remain intentionally unregistered. The
  // google-agent owns free-form Sheets work (including expenses) and Core
  // coordinates it through delegate_to_agent.
  registerPeopleSkills(registry, new DrizzlePeopleRepository(database));
  registerWebSkills(registry, config);
  registerMemorySkills(registry, repository, embeddingProvider, memoryService);
  if (scheduler) registerSchedulerSkills(registry, scheduler);
  const agentRegistry = new AgentRegistry();
  agentRegistry.register({
    id: "device-agent",
    name: "Device Agent",
    description:
      "Handles actions involving the user's connected Android device.",
    capabilities: [
      "make phone calls",
      "search device contacts",
      "read device notifications",
      "send a notification on the device",
      "send text messages (SMS)",
      "read the device's current location",
      "access the camera",
      "read device status (battery, connectivity)",
      "open applications",
      "interact with on-screen applications",
    ],
  });
  agentRegistry.register({
    id: "google-agent",
    name: "Google Agent",
    description: "Handles operations in the configured Google account.",
    capabilities: [
      "browse and search Google Drive",
      "read and update Google Sheets",
      "manage expense data stored in Google Sheets",
      "search, read, send, and reply to Gmail",
      "read, create, update, and delete Google Calendar events",
    ],
  });
  const transport = new RedisAgentTransport({
    redisUrl: config.redisUrl,
    onRedisError: onAuditError,
  });
  const dispatcher = new AgentTaskDispatcher(
    agentRegistry,
    orchestrationRepository,
    transport,
    {
      taskTimeoutMs: config.agentTaskTimeoutMs,
      onPublishError: (error, task) => {
        onAuditError(
          new Error(`Agent task ${task.id} could not be published yet.`, {
            cause: error,
          }),
        );
      },
    },
  );
  registerAgentSkills(registry, dispatcher, agentRegistry);

  const audit = new AgentAuditRepository(database);
  const executor = new SkillExecutor(
    registry,
    new ExecutionPolicyEngine(executionState),
    audit,
    undefined,
    undefined,
    onAuditError,
    confirmations,
  );
  const loop = new AgentLoop(
    new ShivaAgentPlanner(provider, onTrace),
    executor,
    registry,
    config.agentMaxSteps,
    undefined,
    undefined,
    audit,
    undefined,
    onAuditError,
    config.agentRequestTimeoutMs,
    onTrace,
    async ({ requestId, responseId, now }) => {
      await orchestrationRepository.completeRequestAfterConfirmation({
        requestId,
        responseId,
        now,
      });
    },
  );
  const orchestrator = new ShivaOrchestrator(loop);
  const responseProcessor = new CoreAgentResponseProcessor({
    transport,
    repository: orchestrationRepository,
    conversationRepository: repository,
    orchestrator,
    updates,
    userName: config.userName,
    timeZone: config.timeZone,
    workingMemoryMessageLimit: config.workingMemoryMessageLimit,
    reclaimIdleMs: config.agentReclaimIdleMs,
    processingLeaseMs:
      config.agentRequestTimeoutMs + config.agentReclaimIdleMs,
    maxProcessingAttempts: config.agentMaxDeliveryAttempts,
    onError: onAuditError,
  });
  const reliability = new AgentReliabilitySupervisor({
    dispatcher,
    repository: orchestrationRepository,
    responses: responseProcessor,
    onError: onAuditError,
  });
  let started = false;
  let transportConnected = false;
  let responseProcessorStarted = false;

  return {
    orchestrator,
    updateReplay: new DrizzleCoreUpdateReplaySource(database),
    executionStatus: new ExecutionStatusService(
      executionState,
      confirmations,
      config.userId,
    ),
    async start() {
      if (started) return;
      try {
        await transport.connect();
        transportConnected = true;
        for (const agent of agentRegistry.list()) {
          await transport.ensureTaskConsumerGroup(agent.id);
        }
        await responseProcessor.start();
        responseProcessorStarted = true;
        await dispatcher.flushUnpublished();
        reliability.start();
        started = true;
      } catch (error: unknown) {
        await reliability.stop().catch(onAuditError);
        if (responseProcessorStarted) {
          await responseProcessor.stop().catch(onAuditError);
          responseProcessorStarted = false;
        }
        if (transportConnected) {
          await transport.close().catch(onAuditError);
          transportConnected = false;
        }
        throw error;
      }
    },
    async close() {
      started = false;
      await reliability.stop();
      if (responseProcessorStarted) {
        await responseProcessor.stop();
        responseProcessorStarted = false;
      }
      if (transportConnected) {
        await transport.close();
        transportConnected = false;
      }
    },
  };
}

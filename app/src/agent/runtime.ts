import type { AIProvider } from "../brain/ai-provider";
import type { AppConfig } from "../config/environment";
import type { ShivaDatabase } from "../database/pool";
import { DeviceCommandDispatcher } from "../device/device-command-dispatcher";
import type { FaceRecognitionService } from "../face/face-recognition-service";
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
import { registerCoreSkills } from "../skills/core/register";
import { registerSystemSkills } from "../skills/system/register";
import { registerGoogleSkills } from "../skills/google/register";
import { registerPeopleSkills } from "../skills/people/register";
import { registerDeviceSkills } from "../skills/device/register";
import { registerWebSkills } from "../skills/web/register";
import { createPackRegistry } from "../skills/packs";
import { SkillRegistry } from "../skills/registry";
import { AgentLoop } from "./agent-loop";
import { AgentAuditRepository } from "./audit";
import { ShivaOrchestrator } from "./orchestrator";
import { ShivaAgentPlanner, type AgentTraceLogger } from "./planner";
import type { AgentOrchestratorPort } from "./types";

export interface AgentRuntime {
  readonly orchestrator: AgentOrchestratorPort;
  readonly executionStatus: ExecutionStatusService;
  readonly deviceDispatcher: DeviceCommandDispatcher;
}

export function createAgentRuntime(
  database: ShivaDatabase,
  provider: AIProvider,
  config: AppConfig,
  onAuditError: (error: unknown) => void = () => {},
  onTrace?: AgentTraceLogger,
  faceRecognition?: FaceRecognitionService,
): AgentRuntime {
  const registry = new SkillRegistry(createPackRegistry());
  const executionState = new ExecutionStateService(
    new DrizzleExecutionStateStore(database),
    config.maxExecutionMode,
  );
  const confirmations = new ConfirmationService(
    new DrizzleConfirmationStore(database),
    config.confirmationTtlMs,
  );
  registerExecutionControlSkills(registry, executionState, confirmations);
  registerCoreSkills(registry);
  registerSystemSkills(registry);
  // record_expense/expense_report are intentionally not registered: the user
  // chose to manage expenses (and any other sheet) through the free-form
  // google pack (sheets_create/sheets_read/sheets_update) instead of the
  // fixed-schema expense ledger. Their code, tools, and tests are untouched
  // and registerFinanceSkills still works, in case this is ever reverted.
  registerGoogleSkills(registry, config);
  const deviceDispatcher = new DeviceCommandDispatcher({
    ...(onTrace ? { onTrace } : {}),
  });
  registerDeviceSkills(registry, deviceDispatcher, provider, faceRecognition);
  registerPeopleSkills(registry, new DrizzlePeopleRepository(database));
  registerWebSkills(registry, config);

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
  );
  return {
    orchestrator: new ShivaOrchestrator(loop),
    executionStatus: new ExecutionStatusService(
      executionState,
      confirmations,
      config.userId,
    ),
    deviceDispatcher,
  };
}

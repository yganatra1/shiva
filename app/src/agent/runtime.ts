import type { AIProvider } from "../brain/ai-provider.js";
import type { AppConfig } from "../config/environment.js";
import type { ShivaDatabase } from "../database/pool.js";
import {
  ConfirmationService,
  DrizzleConfirmationStore,
} from "../security/confirmation.js";
import {
  DrizzleExecutionStateStore,
  ExecutionStateService,
} from "../security/execution-state.js";
import { ExecutionStatusService } from "../security/execution-status.js";
import { ExecutionPolicyEngine } from "../security/policy-engine.js";
import { SkillExecutor } from "../skills/executor.js";
import { registerExecutionControlSkills } from "../skills/execution-control/register.js";
import { registerCoreSkills } from "../skills/core/register.js";
import { registerSystemSkills } from "../skills/system/register.js";
import { registerGoogleSkills } from "../skills/google/register.js";
import { registerWebSkills } from "../skills/web/register.js";
import { createPackRegistry } from "../skills/packs.js";
import { SkillRegistry } from "../skills/registry.js";
import { AgentLoop } from "./agent-loop.js";
import { AgentAuditRepository } from "./audit.js";
import { ShivaOrchestrator } from "./orchestrator.js";
import { ShivaAgentPlanner } from "./planner.js";
import type { AgentOrchestratorPort } from "./types.js";

export interface AgentRuntime {
  readonly orchestrator: AgentOrchestratorPort;
  readonly executionStatus: ExecutionStatusService;
}

export function createAgentRuntime(
  database: ShivaDatabase,
  provider: AIProvider,
  config: AppConfig,
  onAuditError: (error: unknown) => void = () => {},
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
    new ShivaAgentPlanner(provider),
    executor,
    registry,
    config.agentMaxSteps,
    undefined,
    undefined,
    audit,
    undefined,
    onAuditError,
    config.agentRequestTimeoutMs,
  );
  return {
    orchestrator: new ShivaOrchestrator(loop),
    executionStatus: new ExecutionStatusService(
      executionState,
      confirmations,
      config.userId,
    ),
  };
}

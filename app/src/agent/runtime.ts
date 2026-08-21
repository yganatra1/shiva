import type { AIProvider } from "../brain/ai-provider.js";
import type { AppConfig } from "../config/environment.js";
import type { ShivaDatabase } from "../database/pool.js";
import { PermissionPolicyEngine } from "../security/policy-engine.js";
import { SkillExecutor } from "../skills/executor.js";
import { ExpenseReportSkill } from "../skills/expense-report/skill.js";
import { LearnAboutShivaSkill } from "../skills/learn-about-shiva/skill.js";
import { WorkspaceTerminalSkill } from "../skills/workspace-terminal/skill.js";
import { RecordExpenseSkill } from "../skills/record-expense/skill.js";
import { SkillRegistry } from "../skills/registry.js";
import { WebResearchSkill } from "../skills/web-research/skill.js";
import { ExpenseInsertTool } from "../tools/expenses/insert.js";
import { ExpenseListTool } from "../tools/expenses/list.js";
import {
  GoogleAuthAccessTokenProvider,
} from "../tools/expenses/google-sheets.js";
import { ManagedGoogleSheetsExpenseRepository } from "../tools/expenses/google-sheets-manager.js";
import { GoogleUserOAuthAccessTokenProvider } from "../tools/expenses/google-user-oauth.js";
import { DrizzleExpenseSheetBindingStore } from "../tools/expenses/sheet-binding-repository.js";
import { WebOpenTool } from "../tools/web/open.js";
import { BraveWebSearchTool } from "../tools/web/search.js";
import { FileSystemWorkspaceReader } from "../tools/workspace/reader.js";
import { ReadOnlyWorkspaceTerminal } from "../tools/workspace/terminal.js";
import { AgentLoop } from "./agent-loop.js";
import { AgentAuditRepository } from "./audit.js";
import { ShivaOrchestrator } from "./orchestrator.js";
import { ShivaAgentPlanner } from "./planner.js";
import type { AgentOrchestratorPort } from "./types.js";

export function createAgentRuntime(
  database: ShivaDatabase,
  provider: AIProvider,
  config: AppConfig,
  onAuditError: (error: unknown) => void = () => {},
): AgentOrchestratorPort {
  const registry = new SkillRegistry();
  const workspace = new FileSystemWorkspaceReader();
  registry.register(new LearnAboutShivaSkill(workspace));
  registry.register(
    new WorkspaceTerminalSkill(new ReadOnlyWorkspaceTerminal()),
  );
  if (config.googleUserOAuth || config.expenseSheetId) {
    const accessTokenProvider = config.googleUserOAuth
      ? new GoogleUserOAuthAccessTokenProvider(config.googleUserOAuth)
      : new GoogleAuthAccessTokenProvider();
    const expenses = new ManagedGoogleSheetsExpenseRepository({
      bindingStore: new DrizzleExpenseSheetBindingStore(database),
      accessTokenProvider,
      requestTimeoutMs: config.expenseSheetRequestTimeoutMs,
      ...(config.expenseSheetId
        ? { bootstrapSpreadsheetId: config.expenseSheetId }
        : {}),
    });
    registry.register(new RecordExpenseSkill(new ExpenseInsertTool(expenses)));
    registry.register(new ExpenseReportSkill(new ExpenseListTool(expenses)));
  } else {
    registry.register(new RecordExpenseSkill());
    registry.register(new ExpenseReportSkill());
  }

  if (config.braveSearchApiKey) {
    registry.register(
      new WebResearchSkill(
        new BraveWebSearchTool({
          apiKey: config.braveSearchApiKey,
          baseUrl: config.braveSearchUrl,
          requestTimeoutMs: config.webRequestTimeoutMs,
        }),
        new WebOpenTool({
          requestTimeoutMs: config.webRequestTimeoutMs,
          maxContentBytes: config.webMaxContentBytes,
        }),
      ),
    );
  } else {
    registry.register(new WebResearchSkill());
  }

  const audit = new AgentAuditRepository(database);
  const executor = new SkillExecutor(
    registry,
    new PermissionPolicyEngine(),
    audit,
    undefined,
    undefined,
    onAuditError,
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
  return new ShivaOrchestrator(loop);
}

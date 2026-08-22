import type { ConfirmationService } from "../../security/confirmation.js";
import type { ExecutionStateService } from "../../security/execution-state.js";
import type { SkillRegistry } from "../registry.js";
import {
  GetExecutionModeSkill,
  SetExecutionModeSkill,
  SetLockdownSkill,
} from "./skills.js";

export function registerExecutionControlSkills(
  registry: SkillRegistry,
  executionState: ExecutionStateService,
  confirmations: ConfirmationService,
): void {
  registry.register(new GetExecutionModeSkill(executionState));
  registry.register(new SetExecutionModeSkill(executionState));
  registry.register(new SetLockdownSkill(executionState, confirmations));
}

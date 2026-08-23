import type { ConfirmationService } from "../../security/confirmation";
import type { ExecutionStateService } from "../../security/execution-state";
import type { SkillRegistry } from "../registry";
import {
  GetExecutionModeSkill,
  SetExecutionModeSkill,
  SetLockdownSkill,
} from "./skills";

export function registerExecutionControlSkills(
  registry: SkillRegistry,
  executionState: ExecutionStateService,
  confirmations: ConfirmationService,
): void {
  registry.register(new GetExecutionModeSkill(executionState));
  registry.register(new SetExecutionModeSkill(executionState));
  registry.register(new SetLockdownSkill(executionState, confirmations));
}

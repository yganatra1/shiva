import { ReadOnlyWorkspaceTerminal } from "../../tools/workspace/terminal";
import type { SkillRegistry } from "../registry";
import { WorkspaceTerminalSkill } from "../workspace-terminal/skill";
import { createCalculatorSkill } from "../calculator/skill";
import { createCurrentTimeSkill } from "../current-time/skill";
import { createSystemHealthSkill } from "../system-health/skill";

export function registerSystemSkills(registry: SkillRegistry): void {
  registry.register(new WorkspaceTerminalSkill(new ReadOnlyWorkspaceTerminal()));
  registry.register(createCalculatorSkill());
  registry.register(createCurrentTimeSkill());
  registry.register(createSystemHealthSkill());
}

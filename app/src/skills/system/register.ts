import { ReadOnlyWorkspaceTerminal } from "../../tools/workspace/terminal.js";
import type { SkillRegistry } from "../registry.js";
import { WorkspaceTerminalSkill } from "../workspace-terminal/skill.js";

export function registerSystemSkills(registry: SkillRegistry): void {
  registry.register(new WorkspaceTerminalSkill(new ReadOnlyWorkspaceTerminal()));
}

import { ReadOnlyWorkspaceTerminal } from "../../tools/workspace/terminal";
import type { SkillRegistry } from "../registry";
import { WorkspaceTerminalSkill } from "../workspace-terminal/skill";

export function registerSystemSkills(registry: SkillRegistry): void {
  registry.register(new WorkspaceTerminalSkill(new ReadOnlyWorkspaceTerminal()));
}

import { FileSystemWorkspaceReader } from "../../tools/workspace/reader.js";
import type { SkillRegistry } from "../registry.js";
import { LearnAboutShivaSkill } from "../learn-about-shiva/skill.js";

export function registerCoreSkills(registry: SkillRegistry): void {
  registry.register(new LearnAboutShivaSkill(new FileSystemWorkspaceReader()));
}

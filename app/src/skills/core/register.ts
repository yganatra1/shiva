import { FileSystemWorkspaceReader } from "../../tools/workspace/reader";
import type { SkillRegistry } from "../registry";
import { LearnAboutShivaSkill } from "../learn-about-shiva/skill";

export function registerCoreSkills(registry: SkillRegistry): void {
  registry.register(new LearnAboutShivaSkill(new FileSystemWorkspaceReader()));
}

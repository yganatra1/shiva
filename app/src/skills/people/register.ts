import type { PeopleRepositoryPort } from "../../people/types";
import type { SkillRegistry } from "../registry";
import { createPeopleSearchSkill } from "../people-search/skill";

export function registerPeopleSkills(
  registry: SkillRegistry,
  repository: PeopleRepositoryPort,
): void {
  registry.register(createPeopleSearchSkill(repository));
}

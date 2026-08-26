import type { PeopleRepositoryPort } from "../../people/types";
import type { SkillRegistry } from "../registry";
import { createPersonCreateSkill } from "../person-create/skill";
import { createPersonRelationshipAddSkill } from "../person-relationship-add/skill";
import { createPersonRelationshipSearchSkill } from "../person-relationship-search/skill";
import { createPersonSearchSkill } from "../person-search/skill";
import { createPersonUpdateSkill } from "../person-update/skill";

export function registerPeopleSkills(
  registry: SkillRegistry,
  repository: PeopleRepositoryPort,
): void {
  registry.register(createPersonSearchSkill(repository));
  registry.register(createPersonCreateSkill(repository));
  registry.register(createPersonUpdateSkill(repository));
  registry.register(createPersonRelationshipAddSkill(repository));
  registry.register(createPersonRelationshipSearchSkill(repository));
}

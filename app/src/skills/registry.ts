import { PackRegistry } from "./pack-registry.js";
import type {
  PackSummary,
  RegisteredSkill,
  ShivaSkill,
  SkillSummary,
} from "./types.js";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PACK_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export class InvalidSkillDefinitionError extends Error {
  override readonly name = "InvalidSkillDefinitionError";
}

export class DuplicateSkillError extends Error {
  override readonly name = "DuplicateSkillError";
}

export class UnknownSkillError extends Error {
  override readonly name = "UnknownSkillError";
}

export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();

  /**
   * The pack registry is optional so unit tests exercising unrelated
   * concerns can construct a bare `new SkillRegistry()` without also having
   * to seed a pack catalog. When omitted, `skill.pack` is still required and
   * format-checked, but its existence is not enforced. Production wiring
   * (`createAgentRuntime`) always supplies one, so real skills get full
   * pack-existence validation.
   */
  constructor(private readonly packs?: PackRegistry) {}

  register<TInput, TOutput>(skill: ShivaSkill<TInput, TOutput>): void {
    validateDefinition(skill, this.packs);
    if (this.skills.has(skill.name)) {
      throw new DuplicateSkillError(`Skill '${skill.name}' is already registered.`);
    }
    this.skills.set(skill.name, eraseSkillTypes(skill));
  }

  get(name: string): RegisteredSkill {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new UnknownSkillError(`Skill '${name}' is not registered.`);
    }
    return skill;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  hasPack(name: string): boolean {
    return this.packs?.has(name) ?? false;
  }

  list(): readonly SkillSummary[] {
    return [...this.skills.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      inputDescription: skill.inputDescription,
      pack: skill.pack,
      configured: skill.configured,
      execution: { ...skill.execution },
    }));
  }

  /** Level-1 catalog: every pack with at least one registered skill. */
  listPacks(): readonly PackSummary[] {
    const byPack = new Map<string, { count: number; configured: boolean }>();
    for (const skill of this.skills.values()) {
      const existing = byPack.get(skill.pack) ?? { count: 0, configured: false };
      byPack.set(skill.pack, {
        count: existing.count + 1,
        configured: existing.configured || skill.configured,
      });
    }
    const catalog = this.packs?.list() ?? [];
    return catalog
      .filter((pack) => byPack.has(pack.name))
      .map((pack) => {
        const aggregate = byPack.get(pack.name);
        return {
          name: pack.name,
          description: pack.description,
          skillCount: aggregate?.count ?? 0,
          configured: aggregate?.configured ?? false,
        };
      });
  }
}

function validateDefinition<TInput, TOutput>(
  skill: ShivaSkill<TInput, TOutput>,
  packs?: PackRegistry,
): void {
  if (!SKILL_NAME_PATTERN.test(skill.name)) {
    throw new InvalidSkillDefinitionError(
      "Skill names must be lowercase snake_case identifiers.",
    );
  }
  if (skill.description.trim().length === 0) {
    throw new InvalidSkillDefinitionError("Skill descriptions cannot be empty.");
  }
  if (skill.inputDescription.trim().length === 0) {
    throw new InvalidSkillDefinitionError(
      "Skill input descriptions cannot be empty.",
    );
  }
  if (!PACK_NAME_PATTERN.test(skill.pack)) {
    throw new InvalidSkillDefinitionError(
      `Skill '${skill.name}' has an invalid pack name.`,
    );
  }
  if (packs && !packs.has(skill.pack)) {
    throw new InvalidSkillDefinitionError(
      `Skill '${skill.name}' references unknown pack '${skill.pack}'.`,
    );
  }
  validateExecutionMetadata(skill.name, skill.execution);
}

function validateExecutionMetadata(
  skillName: string,
  execution: RegisteredSkill["execution"],
): void {
  if (
    !execution ||
    (execution.mutability !== "read" && execution.mutability !== "write")
  ) {
    throw new InvalidSkillDefinitionError(
      `Skill '${skillName}' has an invalid execution mutability.`,
    );
  }
  if (
    execution.impact !== "normal" &&
    execution.impact !== "sensitive"
  ) {
    throw new InvalidSkillDefinitionError(
      `Skill '${skillName}' has an invalid execution impact.`,
    );
  }
  if (
    execution.confirmationReason !== undefined &&
    execution.confirmationReason.trim().length === 0
  ) {
    throw new InvalidSkillDefinitionError(
      `Skill '${skillName}' has an empty confirmation reason.`,
    );
  }
  if (
    execution.control !== undefined &&
    execution.control !== "execution_mode" &&
    execution.control !== "lockdown"
  ) {
    throw new InvalidSkillDefinitionError(
      `Skill '${skillName}' has an invalid execution control type.`,
    );
  }
}

function eraseSkillTypes<TInput, TOutput>(
  skill: ShivaSkill<TInput, TOutput>,
): RegisteredSkill {
  const erased: RegisteredSkill = {
    name: skill.name,
    description: skill.description,
    inputDescription: skill.inputDescription,
    pack: skill.pack,
    configured: skill.configured ?? true,
    inputSchema: skill.inputSchema as unknown as RegisteredSkill["inputSchema"],
    execution: { ...skill.execution },
    execute: async (input, context) =>
      skill.execute(input as TInput, context),
  };
  if (skill.classifyExecution) {
    return {
      ...erased,
      classifyExecution: async (input, context) => {
        const execution = await skill.classifyExecution?.(
          input as TInput,
          context,
        );
        if (!execution) {
          throw new InvalidSkillDefinitionError(
            `Skill '${skill.name}' did not return execution metadata.`,
          );
        }
        validateExecutionMetadata(skill.name, execution);
        return { ...execution };
      },
    };
  }
  return erased;
}

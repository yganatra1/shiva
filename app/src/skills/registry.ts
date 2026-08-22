import type {
  RegisteredSkill,
  ShivaSkill,
  SkillSummary,
} from "./types.js";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

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

  register<TInput, TOutput>(skill: ShivaSkill<TInput, TOutput>): void {
    validateDefinition(skill);
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

  list(): readonly SkillSummary[] {
    return [...this.skills.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      inputDescription: skill.inputDescription,
      configured: skill.configured,
      execution: { ...skill.execution },
    }));
  }
}

function validateDefinition<TInput, TOutput>(
  skill: ShivaSkill<TInput, TOutput>,
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

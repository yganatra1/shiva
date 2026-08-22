const PACK_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export interface SkillPack {
  readonly name: string;
  readonly description: string;
}

export class InvalidPackDefinitionError extends Error {
  override readonly name = "InvalidPackDefinitionError";
}

export class DuplicatePackError extends Error {
  override readonly name = "DuplicatePackError";
}

/**
 * Discovery/context-organization catalog only. A pack has zero authority over
 * execution — it never participates in permission, confirmation, or audit
 * decisions. Its sole purpose is letting the planner narrow which skills it
 * needs full definitions for before seeing them, so an unscoped planner turn
 * can show a short pack catalog instead of every registered skill.
 */
export class PackRegistry {
  private readonly packs = new Map<string, SkillPack>();

  register(pack: SkillPack): void {
    if (!PACK_NAME_PATTERN.test(pack.name)) {
      throw new InvalidPackDefinitionError(
        "Pack names must be lowercase snake_case identifiers.",
      );
    }
    if (pack.description.trim().length === 0) {
      throw new InvalidPackDefinitionError("Pack descriptions cannot be empty.");
    }
    if (this.packs.has(pack.name)) {
      throw new DuplicatePackError(`Pack '${pack.name}' is already registered.`);
    }
    this.packs.set(pack.name, { name: pack.name, description: pack.description });
  }

  has(name: string): boolean {
    return this.packs.has(name);
  }

  list(): readonly SkillPack[] {
    return [...this.packs.values()];
  }
}

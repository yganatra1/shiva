import { PackRegistry } from "./pack-registry";

/**
 * The pack catalog is seeded statically and only contains packs that have at
 * least one real registered skill today. A pack appears here the moment its
 * first skill is built (see docs/skill-middle-layer-plan.md Phase 4), not
 * ahead of time — an empty pack would waste a planner's open_packs hop.
 */
export interface PackRegistryOptions {
  /** Specialized Google workers keep this pack; Core delegates it instead. */
  readonly includeGoogle?: boolean;
}

export function createPackRegistry(
  options: PackRegistryOptions = {},
): PackRegistry {
  const packs = new PackRegistry();
  packs.register({
    name: "execution_control",
    description:
      "Read or change Shiva's own execution mode (SAFE/AUTO/FULL_ACCESS) and emergency lockdown state.",
  });
  packs.register({
    name: "core",
    description:
      "Shiva's self-knowledge: inspect its own repository, documentation, and configuration.",
  });
  packs.register({
    name: "system",
    description:
      "Inspect the Shiva host/workspace through a read-only terminal.",
  });
  packs.register({
    name: "web",
    description: "Search the web and read current public pages.",
  });
  if (options.includeGoogle !== false) {
    packs.register({
      name: "google",
      description:
        "Create, read, and update Google Sheets with whatever structure the task needs.",
    });
  }
  packs.register({
    name: "people",
    description:
      "Look up people Shiva has been taught, their aliases, relationships, profile details, and face-enrollment status.",
  });
  packs.register({
    name: "agents",
    description:
      "Delegate a self-contained goal to one of Shiva's autonomous background agents and get back its result. All Android-phone work, including direct contacts, calls, notifications, and camera requests, belongs to the device agent in this pack.",
  });
  return packs;
}

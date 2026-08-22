import { PackRegistry } from "./pack-registry.js";

/**
 * The pack catalog is seeded statically and only contains packs that have at
 * least one real registered skill today. A pack appears here the moment its
 * first skill is built (see docs/skill-middle-layer-plan.md Phase 4), not
 * ahead of time — an empty pack would waste a planner's open_packs hop.
 */
export function createPackRegistry(): PackRegistry {
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
  packs.register({
    name: "google",
    description:
      "Create, read, and update Google Sheets with whatever structure the task needs.",
  });
  packs.register({
    name: "device",
    description:
      "Act through the connected Android phone: search contacts, place calls, read notifications, capture and describe photos.",
  });
  return packs;
}

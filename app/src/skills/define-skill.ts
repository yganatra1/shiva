import type { ShivaSkill } from "./types";

/**
 * Typed identity helper so a new skill can be written as one object literal
 * instead of a full class. `ShivaSkill` is already just an interface — this
 * exists purely for inference (TInput/TOutput are picked up from `execute`
 * without repeating the generics by hand) and as the conventional entry
 * point future skills are expected to use.
 */
export function defineSkill<TInput, TOutput>(
  skill: ShivaSkill<TInput, TOutput>,
): ShivaSkill<TInput, TOutput> {
  return skill;
}

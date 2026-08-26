import { z } from "zod";

import { PersonAlreadyExistsError, type PeopleRepositoryPort } from "../../people/types";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    personId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255).optional(),
    relationship: z.string().trim().min(1).max(500).nullable().optional(),
    notes: z.string().trim().min(1).max(10_000).nullable().optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "personId"),
    "At least one field must be updated.",
  );

export function createPersonUpdateSkill(repository: PeopleRepositoryPort) {
  return defineSkill({
    name: "person_update",
    description:
      "Updates fields on an existing person by personId. Use person_search first to resolve the personId. Only supplied fields change; pass null to clear relationship or notes. Renaming to a name that collides with a different existing person fails closed instead of merging or duplicating anyone.",
    inputDescription:
      '{"personId":UUID,"displayName"?:string,"relationship"?:string|null,"notes"?:string|null}',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: true,
    async execute(input, context) {
      try {
        const person = await repository.updatePerson({
          userId: context.userId,
          personId: input.personId,
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(input.relationship !== undefined
            ? { relationship: input.relationship }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        });
        if (!person) {
          return {
            success: false,
            error: {
              code: "PERSON_NOT_FOUND",
              message: "The person does not exist for the configured user.",
            },
          };
        }
        return {
          success: true,
          data: { personId: person.id, displayName: person.displayName },
        };
      } catch (error: unknown) {
        if (error instanceof PersonAlreadyExistsError) {
          return {
            success: false,
            error: {
              code: "PERSON_ALREADY_EXISTS",
              message: error.message,
            },
          };
        }
        throw error;
      }
    },
  });
}

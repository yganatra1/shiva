import { z } from "zod";

import { PersonAlreadyExistsError, type PeopleRepositoryPort } from "../../people/types";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    relationship: z.string().trim().min(1).max(500).optional(),
    notes: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict();

export function createPersonCreateSkill(repository: PeopleRepositoryPort) {
  return defineSkill({
    name: "person_create",
    description:
      "Creates a new person Shiva can remember. Use person_relationship_add afterward to link them to other known people (e.g. the owner). Use person_search first to check the person doesn't already exist — creating one with a name that already matches an existing person (or their alias) fails closed instead of making a duplicate; use person_update on the existing person instead.",
    inputDescription:
      '{"displayName":string,"relationship"?:string (relationship to the account owner),"notes"?:string}',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: true,
    async execute(input, context) {
      try {
        const person = await repository.createPerson({
          userId: context.userId,
          displayName: input.displayName,
          ...(input.relationship ? { relationship: input.relationship } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        });
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

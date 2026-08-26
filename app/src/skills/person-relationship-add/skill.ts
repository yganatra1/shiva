import { z } from "zod";

import type { PeopleRepositoryPort } from "../../people/types";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    fromPersonId: z.string().uuid(),
    toPersonId: z.string().uuid(),
    relationship: z.string().trim().min(1).max(500),
    notes: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict();

export function createPersonRelationshipAddSkill(
  repository: PeopleRepositoryPort,
) {
  return defineSkill({
    name: "person_relationship_add",
    description:
      'Records a directed relationship from one known person to another, e.g. fromPersonId=Yash, toPersonId=Rajesh, relationship="father" means "Rajesh is Yash\'s father." relationship is free text (father, wife, brother, manager, business partner, ...). Use person_search first to resolve both personIds; re-adding the same fromPersonId/toPersonId/relationship updates its notes instead of duplicating.',
    inputDescription:
      '{"fromPersonId":UUID,"toPersonId":UUID,"relationship":string,"notes"?:string}',
    inputSchema,
    execution: { mutability: "write", impact: "normal" },
    configured: true,
    async execute(input, context) {
      try {
        const relationship = await repository.addRelationship({
          userId: context.userId,
          fromPersonId: input.fromPersonId,
          toPersonId: input.toPersonId,
          relationship: input.relationship,
          ...(input.notes ? { notes: input.notes } : {}),
        });
        return {
          success: true,
          data: {
            relationshipId: relationship.id,
            fromPersonId: relationship.fromPersonId,
            toPersonId: relationship.toPersonId,
            toPersonDisplayName: relationship.toPersonDisplayName,
            relationship: relationship.relationship,
          },
        };
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          return {
            success: false,
            error: { code: "PERSON_RELATIONSHIP_INVALID", message: error.message },
          };
        }
        throw error;
      }
    },
  });
}

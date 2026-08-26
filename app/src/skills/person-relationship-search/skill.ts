import { z } from "zod";

import type { PeopleRepositoryPort, PersonRelationship } from "../../people/types";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    personId: z.string().uuid(),
  })
  .strict();

export function createPersonRelationshipSearchSkill(
  repository: PeopleRepositoryPort,
) {
  return defineSkill({
    name: "person_relationship_search",
    description:
      'Lists a known person\'s outgoing relationships (e.g. personId=Yash returns [{relationship:"father", toPersonDisplayName:"Rajesh"}, {relationship:"wife", toPersonDisplayName:"Charmi"}]). Chain calls to resolve indirect references like "my wife\'s brother": look up the owner, follow "wife" to get Charmi\'s personId, then search again from Charmi to follow "brother".',
    inputDescription: '{"personId":UUID}',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(input, context) {
      const relationships = await repository.listRelationshipsFrom(
        context.userId,
        input.personId,
      );
      return {
        success: true,
        data: {
          relationships: relationships.map(skillRelationship),
          count: relationships.length,
        },
      };
    },
  });
}

function skillRelationship(relationship: PersonRelationship) {
  return {
    relationshipId: relationship.id,
    toPersonId: relationship.toPersonId,
    toPersonDisplayName: relationship.toPersonDisplayName,
    relationship: relationship.relationship,
    notes: relationship.notes,
  };
}

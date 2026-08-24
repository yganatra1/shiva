import { z } from "zod";

import type { PeopleRepositoryPort, Person } from "../../people/types";
import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    query: z.string().trim().max(255).default(""),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export function createPeopleSearchSkill(repository: PeopleRepositoryPort) {
  return defineSkill({
    name: "people_search",
    description:
      "Looks up people Shiva has been explicitly taught, including aliases, relationship, structured details, notes, and face-enrollment readiness. Use this for durable person facts; it does not run face recognition.",
    inputDescription:
      '{"query":"optional name, alias, relationship, or detail text","limit":1..25}',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(input, context) {
      const people = input.query
        ? await repository.searchPeople(context.userId, input.query, input.limit)
        : (await repository.listPeople(context.userId)).slice(0, input.limit);
      return {
        success: true,
        data: {
          people: people.map(skillPerson),
          count: people.length,
        },
      };
    },
  });
}

function skillPerson(person: Person) {
  return {
    personId: person.id,
    displayName: person.displayName,
    isOwner: person.isOwner,
    aliases: person.aliases,
    relationship: person.relationship,
    details: person.details,
    notes: person.notes,
    faceSampleCount: person.faceSampleCount,
    faceReady: person.faceReady,
  };
}

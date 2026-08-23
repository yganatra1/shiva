import assert from "node:assert/strict";
import { test } from "node:test";

import { createPeopleSearchSkill } from "../src/skills/people-search/skill";
import type { SkillContext } from "../src/skills/types";
import { InMemoryPeopleRepository } from "./people-test-support";
import { testConfig } from "./test-support";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: testConfig.userId,
  userName: testConfig.userName,
  timeZone: testConfig.timeZone,
  now: () => new Date("2026-08-23T12:00:00.000Z"),
};

test("people_search exposes taught details but no biometric templates", async () => {
  const repository = new InMemoryPeopleRepository();
  await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Charmi",
    relationship: "wife",
    aliases: ["Chimu"],
    details: { city: "Ahmedabad", birthday: "12 March" },
    notes: "Likes masala chai.",
  });
  const skill = createPeopleSearchSkill(repository);

  const result = await skill.execute({ query: "wife", limit: 10 }, context);

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.count, 1);
  assert.equal(result.data.people[0]?.displayName, "Charmi");
  assert.deepEqual(result.data.people[0]?.details, {
    city: "Ahmedabad",
    birthday: "12 March",
  });
  assert.doesNotMatch(JSON.stringify(result), /embedding|imageSha256/);
});

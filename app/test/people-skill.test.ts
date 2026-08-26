import assert from "node:assert/strict";
import { test } from "node:test";

import { createPersonCreateSkill } from "../src/skills/person-create/skill";
import { createPersonRelationshipAddSkill } from "../src/skills/person-relationship-add/skill";
import { createPersonRelationshipSearchSkill } from "../src/skills/person-relationship-search/skill";
import { createPersonSearchSkill } from "../src/skills/person-search/skill";
import { createPersonUpdateSkill } from "../src/skills/person-update/skill";
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

test("person_search exposes taught details but no biometric templates", async () => {
  const repository = new InMemoryPeopleRepository();
  await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Charmi",
    relationship: "wife",
    aliases: ["Chimu"],
    details: { city: "Ahmedabad", birthday: "12 March" },
    notes: "Likes masala chai.",
  });
  const skill = createPersonSearchSkill(repository);

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

test("person_create refuses to create a second person with the same name", async () => {
  const repository = new InMemoryPeopleRepository();
  const createSkill = createPersonCreateSkill(repository);

  const first = await createSkill.execute({ displayName: "Rajesh" }, context);
  assert.equal(first.success, true);

  const second = await createSkill.execute({ displayName: "Rajesh" }, context);
  assert.equal(second.success, false);
  if (second.success) return;
  assert.equal(second.error.code, "PERSON_ALREADY_EXISTS");
});

test("person_create refuses a name that matches an existing alias", async () => {
  const repository = new InMemoryPeopleRepository();
  await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Charmi",
    aliases: ["Chimu"],
  });
  const createSkill = createPersonCreateSkill(repository);

  const result = await createSkill.execute({ displayName: "Chimu" }, context);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.code, "PERSON_ALREADY_EXISTS");
});

test("person_update refuses to rename a person onto a different existing person's name", async () => {
  const repository = new InMemoryPeopleRepository();
  await repository.createPerson({ userId: testConfig.userId, displayName: "Rajesh" });
  const kiran = await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Kiran",
  });
  const updateSkill = createPersonUpdateSkill(repository);

  const result = await updateSkill.execute(
    { personId: kiran.id, displayName: "Rajesh" },
    context,
  );
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.code, "PERSON_ALREADY_EXISTS");
});

test("person_relationship_add and person_relationship_search resolve a chain of relationships", async () => {
  const repository = new InMemoryPeopleRepository();
  const yash = await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
    isOwner: true,
  });
  const charmi = await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Charmi",
  });
  const amit = await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Amit",
  });
  const addSkill = createPersonRelationshipAddSkill(repository);
  const searchSkill = createPersonRelationshipSearchSkill(repository);

  const addWife = await addSkill.execute(
    { fromPersonId: yash.id, toPersonId: charmi.id, relationship: "wife" },
    context,
  );
  assert.equal(addWife.success, true);
  const addBrother = await addSkill.execute(
    { fromPersonId: charmi.id, toPersonId: amit.id, relationship: "brother" },
    context,
  );
  assert.equal(addBrother.success, true);

  const fromYash = await searchSkill.execute({ personId: yash.id }, context);
  assert.equal(fromYash.success, true);
  if (!fromYash.success) return;
  assert.equal(fromYash.data.count, 1);
  assert.equal(fromYash.data.relationships[0]?.relationship, "wife");
  assert.equal(fromYash.data.relationships[0]?.toPersonDisplayName, "Charmi");

  const fromCharmi = await searchSkill.execute({ personId: charmi.id }, context);
  assert.equal(fromCharmi.success, true);
  if (!fromCharmi.success) return;
  assert.equal(fromCharmi.data.relationships[0]?.toPersonDisplayName, "Amit");
});

test("person_relationship_add rejects a personId not owned by the user", async () => {
  const repository = new InMemoryPeopleRepository();
  const yash = await repository.createPerson({
    userId: testConfig.userId,
    displayName: "Yash",
  });
  const addSkill = createPersonRelationshipAddSkill(repository);

  const result = await addSkill.execute(
    {
      fromPersonId: yash.id,
      toPersonId: "30000000-0000-4000-8000-000000000099",
      relationship: "father",
    },
    context,
  );
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.code, "PERSON_RELATIONSHIP_INVALID");
});

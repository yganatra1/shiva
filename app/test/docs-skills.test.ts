import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { createDocsCreateSkill } from "../src/skills/docs-create/skill.js";
import { createDocsFindSkill } from "../src/skills/docs-find/skill.js";
import { createDocsUpdateSkill } from "../src/skills/docs-update/skill.js";
import type { SkillContext } from "../src/skills/types.js";
import {
  GoogleDocsClient,
  type CreatedDocument,
  type UpdatedDocument,
} from "../src/tools/docs/client.js";
import {
  GoogleDriveClient,
  type DriveFile,
} from "../src/tools/drive/client.js";

const context: SkillContext = {
  agentRunId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  now: () => new Date("2026-08-22T00:00:00Z"),
};

class FakeDocsClient extends GoogleDocsClient {
  created: unknown[] = [];
  updated: unknown[] = [];
  createResult: CreatedDocument = {
    documentId: "doc-1",
    title: "Untitled Document",
    url: "https://docs.google.com/document/d/doc-1/edit",
  };
  updateResult: UpdatedDocument = { documentId: "doc-1", mode: "append" };

  constructor() {
    super({
      accessTokenProvider: { getAccessToken: async () => "unused" },
      requestTimeoutMs: 1_000,
    });
  }

  override async createDocument(input: unknown): Promise<CreatedDocument> {
    this.created.push(input);
    return this.createResult;
  }

  override async updateDocument(input: unknown): Promise<UpdatedDocument> {
    this.updated.push(input);
    return this.updateResult;
  }
}

class FakeDriveClient extends GoogleDriveClient {
  queries: unknown[] = [];
  matches: readonly DriveFile[] = [
    {
      id: "doc-1",
      name: "Meeting Notes",
      mimeType: "application/vnd.google-apps.document",
      url: "https://docs.google.com/document/d/doc-1",
      modifiedTime: "2026-08-22T00:00:00Z",
    },
  ];

  constructor() {
    super({
      accessTokenProvider: { getAccessToken: async () => "unused" },
      requestTimeoutMs: 1_000,
    });
  }

  override async findDocuments(input: unknown): Promise<readonly DriveFile[]> {
    this.queries.push(input);
    return this.matches;
  }
}

function registryWithDocsSkills(
  docsClient?: GoogleDocsClient,
  driveClient?: GoogleDriveClient,
): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(createDocsCreateSkill(docsClient));
  registry.register(createDocsUpdateSkill(docsClient));
  registry.register(createDocsFindSkill(driveClient));
  return registry;
}

test("docs_create defaults the title and reports configured, normal write", async () => {
  const client = new FakeDocsClient();
  const registry = registryWithDocsSkills(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute("docs_create", {}, context, {
    userAuthorized: true,
  });

  assert.deepEqual(result, { success: true, data: client.createResult });
  assert.deepEqual(client.created[0], { title: "Untitled Document" });
  const summary = registry.list().find((skill) => skill.name === "docs_create");
  assert.equal(summary?.configured, true);
  assert.deepEqual(summary?.execution, { mutability: "write", impact: "normal" });
});

test("docs_create passes through a given title and initialText", async () => {
  const client = new FakeDocsClient();
  const registry = registryWithDocsSkills(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  await executor.execute(
    "docs_create",
    { title: "Roadmap", initialText: "Q1 goals" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(client.created[0], { title: "Roadmap", initialText: "Q1 goals" });
});

test("docs_update requires an explicit mode and reaches the client", async () => {
  const client = new FakeDocsClient();
  const registry = registryWithDocsSkills(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "docs_update",
    { documentId: "doc-1", text: "more text", mode: "append" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, { success: true, data: client.updateResult });
  assert.deepEqual(client.updated[0], {
    documentId: "doc-1",
    text: "more text",
    mode: "append",
  });

  const missingMode = await executor.execute(
    "docs_update",
    { documentId: "doc-1", text: "more text" },
    context,
    { userAuthorized: true },
  );
  assert.equal(missingMode.success, false);
});

test("docs_find searches Drive and returns ranked matches", async () => {
  const driveClient = new FakeDriveClient();
  const registry = registryWithDocsSkills(new FakeDocsClient(), driveClient);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "docs_find",
    { query: "meeting notes" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, { success: true, data: { matches: driveClient.matches } });
  assert.equal(driveClient.queries.length, 1);
  const summary = registry.list().find((skill) => skill.name === "docs_find");
  assert.deepEqual(summary?.execution, { mutability: "read", impact: "normal" });
});

test("all docs skills report unavailable and configured=false when their client isn't set up", async () => {
  const registry = registryWithDocsSkills(undefined, undefined);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  for (const skill of ["docs_create", "docs_update", "docs_find"] as const) {
    const summary = registry.list().find((entry) => entry.name === skill);
    assert.equal(summary?.configured, false, skill);
  }

  const createResult = await executor.execute("docs_create", {}, context, {
    userAuthorized: true,
  });
  assert.equal(createResult.success, false);
  if (!createResult.success) {
    assert.equal(createResult.error.code, "GOOGLE_DOCS_UNAVAILABLE");
  }

  const findResult = await executor.execute(
    "docs_find",
    { query: "x" },
    context,
    { userAuthorized: true },
  );
  assert.equal(findResult.success, false);
  if (!findResult.success) {
    assert.equal(findResult.error.code, "GOOGLE_DRIVE_UNAVAILABLE");
  }
});

test("the registry lists all three docs skills as configured", () => {
  const registry = registryWithDocsSkills(new FakeDocsClient(), new FakeDriveClient());
  const names = registry.list().map((skill) => skill.name);
  assert.deepEqual(
    [...names].sort(),
    ["docs_create", "docs_find", "docs_update"].sort(),
  );
  assert.ok(registry.list().every((skill) => skill.configured));
});

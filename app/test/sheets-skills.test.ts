import assert from "node:assert/strict";
import { test } from "node:test";

import { ExecutionPolicyEngine } from "../src/security/policy-engine.js";
import { SkillExecutor } from "../src/skills/executor.js";
import { PackRegistry } from "../src/skills/pack-registry.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { createSheetsAddTabSkill } from "../src/skills/sheets-add-tab/skill.js";
import { createSheetsCreateSkill } from "../src/skills/sheets-create/skill.js";
import { createSheetsFindSkill } from "../src/skills/sheets-find/skill.js";
import { createSheetsReadSkill } from "../src/skills/sheets-read/skill.js";
import { createSheetsUpdateSkill } from "../src/skills/sheets-update/skill.js";
import type { SkillContext } from "../src/skills/types.js";
import {
  GoogleSheetsClient,
  SheetsClientError,
  type CreatedSpreadsheet,
  type CreatedTab,
  type ListTabsResult,
  type ReadValuesResult,
  type WriteValuesResult,
} from "../src/tools/sheets/client.js";
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

class FakeSheetsClient extends GoogleSheetsClient {
  created: unknown[] = [];
  listedTabs: unknown[] = [];
  written: unknown[] = [];
  addedTabs: unknown[] = [];
  createResult: CreatedSpreadsheet = {
    spreadsheetId: "sheet-1",
    url: "https://docs.google.com/spreadsheets/d/sheet-1",
    tabs: [{ name: "Sheet1", sheetId: 0 }],
  };
  readResult: ReadValuesResult = { range: "Sheet1!A1:A1", values: [["hi"]] };
  listTabsResult: ListTabsResult = {
    tabs: [
      { name: "July 2026", sheetId: 10 },
      { name: "August 2026", sheetId: 11 },
    ],
  };
  readError: unknown;
  writeResult: WriteValuesResult = {
    updatedRange: "Sheet1!A2:A2",
    updatedRows: 1,
    updatedColumns: 1,
  };
  addTabResult: CreatedTab = { name: "March", sheetId: 7 };

  constructor() {
    super({
      accessTokenProvider: { getAccessToken: async () => "unused" },
      requestTimeoutMs: 1_000,
    });
  }

  override async createSpreadsheet(input: unknown): Promise<CreatedSpreadsheet> {
    this.created.push(input);
    return this.createResult;
  }

  override async getValues(): Promise<ReadValuesResult> {
    if (this.readError) throw this.readError;
    return this.readResult;
  }

  override async listTabs(input: unknown): Promise<ListTabsResult> {
    this.listedTabs.push(input);
    return this.listTabsResult;
  }

  override async writeValues(input: unknown): Promise<WriteValuesResult> {
    this.written.push(input);
    return this.writeResult;
  }

  override async addTab(input: unknown): Promise<CreatedTab> {
    this.addedTabs.push(input);
    return this.addTabResult;
  }
}

class FakeDriveClient extends GoogleDriveClient {
  queries: unknown[] = [];
  matches: readonly DriveFile[] = [
    {
      id: "sheet-1",
      name: "Expenses 2026",
      url: "https://docs.google.com/spreadsheets/d/sheet-1",
      modifiedTime: "2026-08-22T00:00:00Z",
    },
  ];

  constructor() {
    super({
      accessTokenProvider: { getAccessToken: async () => "unused" },
      requestTimeoutMs: 1_000,
    });
  }

  override async findSpreadsheets(input: unknown): Promise<readonly DriveFile[]> {
    this.queries.push(input);
    return this.matches;
  }
}

function registryWithGooglePack(
  sheetsClient?: GoogleSheetsClient,
  driveClient?: GoogleDriveClient,
): SkillRegistry {
  const packs = new PackRegistry();
  packs.register({ name: "google", description: "Google Sheets." });
  const registry = new SkillRegistry(packs);
  registry.register(createSheetsCreateSkill(sheetsClient));
  registry.register(createSheetsReadSkill(sheetsClient));
  registry.register(createSheetsUpdateSkill(sheetsClient));
  registry.register(createSheetsAddTabSkill(sheetsClient));
  registry.register(createSheetsFindSkill(driveClient));
  return registry;
}

test("sheets_create builds a multi-tab spreadsheet and reports it as configured, pack google, normal write", async () => {
  const client = new FakeSheetsClient();
  const registry = registryWithGooglePack(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "sheets_create",
    {
      title: "Expenses 2026",
      tabs: [
        {
          name: "January",
          headers: ["Date", "Category", "Amount"],
          rows: [["2026-01-05", "Food", 12.5]],
          columnOptions: { Category: ["Food", "Transport"] },
        },
      ],
    },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, { success: true, data: client.createResult });
  assert.equal(client.created.length, 1);
  const summary = registry.list().find((skill) => skill.name === "sheets_create");
  assert.equal(summary?.pack, "google");
  assert.equal(summary?.configured, true);
  assert.deepEqual(summary?.execution, { mutability: "write", impact: "normal" });
});

test("sheets_create defaults everything and never fails on unrecognized or malformed structure", async () => {
  const client = new FakeSheetsClient();
  const registry = registryWithGooglePack(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  // No title, no tabs at all: the simplest possible call a struggling model
  // might send when it isn't confident about the full shape.
  const bare = await executor.execute("sheets_create", {}, context, {
    userAuthorized: true,
  });
  assert.equal(bare.success, true);
  assert.deepEqual(client.created[0], {
    title: "Untitled Spreadsheet",
    tabs: [{ name: "Sheet1" }],
  });

  // A tab missing its name, an unrecognized sibling key (as if the model had
  // written columnHeaders instead of headers), and a columnOptions entry
  // referencing a header that doesn't exist — none of it should fail the call.
  const messy = await executor.execute(
    "sheets_create",
    {
      title: "  ",
      extraTopLevelKey: "ignored",
      tabs: [
        {
          headers: ["Date", "Amount"],
          columnHeaders: ["wrong key, ignored"],
          columnOptions: { Amount: ["10", "20"], NotAHeader: ["x"] },
        },
      ],
    },
    context,
    { userAuthorized: true },
  );
  assert.equal(messy.success, true);
  assert.deepEqual(client.created[1], {
    title: "Untitled Spreadsheet",
    tabs: [
      {
        name: "Sheet1",
        headers: ["Date", "Amount"],
        columnOptions: { Amount: ["10", "20"] },
      },
    ],
  });
});

test("sheets_read, sheets_update, and sheets_add_tab reach the client and return its result", async () => {
  const client = new FakeSheetsClient();
  const registry = registryWithGooglePack(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const read = await executor.execute(
    "sheets_read",
    { spreadsheetId: "sheet-1", range: "Sheet1!A1:A1" },
    context,
    { userAuthorized: true },
  );
  assert.deepEqual(read, { success: true, data: client.readResult });

  const tabs = await executor.execute(
    "sheets_read",
    { spreadsheetId: "sheet-1" },
    context,
    { userAuthorized: true },
  );
  assert.deepEqual(tabs, { success: true, data: client.listTabsResult });
  assert.equal(client.listedTabs.length, 1);
  const readSummary = registry.list().find((skill) => skill.name === "sheets_read");
  assert.match(readSummary?.description ?? "", /only spreadsheetId.*exact tabs/i);
  assert.match(readSummary?.description ?? "", /never guess.*Sheet1/i);

  client.readError = new SheetsClientError(
    "INVALID_INPUT",
    "The requested spreadsheet or A1 range was invalid or not found.",
  );
  const recoveredTabs = await executor.execute(
    "sheets_read",
    { spreadsheetId: "sheet-1", range: "Sheet1!A1:E50" },
    context,
    { userAuthorized: true },
  );
  assert.deepEqual(recoveredTabs, {
    success: true,
    data: {
      ...client.listTabsResult,
      rejectedRange: "Sheet1!A1:E50",
    },
  });

  const update = await executor.execute(
    "sheets_update",
    {
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:A1",
      values: [["updated"]],
      mode: "append",
    },
    context,
    { userAuthorized: true },
  );
  assert.deepEqual(update, { success: true, data: client.writeResult });
  assert.equal(client.written.length, 1);
  assert.match(
    registry.list().find((skill) => skill.name === "sheets_update")
      ?.description ?? "",
    /use sheets_read.*live header\/current structure/i,
  );

  const addTab = await executor.execute(
    "sheets_add_tab",
    {
      spreadsheetId: "sheet-1",
      name: "March",
      headers: ["Date", "Amount"],
    },
    context,
    { userAuthorized: true },
  );
  assert.deepEqual(addTab, { success: true, data: client.addTabResult });
  assert.equal(client.addedTabs.length, 1);
});

test("sheets_add_tab defaults name and drops columnOptions with no matching header", async () => {
  const client = new FakeSheetsClient();
  const registry = registryWithGooglePack(client, new FakeDriveClient());
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "sheets_add_tab",
    { spreadsheetId: "sheet-1", columnOptions: { Category: ["Food"] } },
    context,
    { userAuthorized: true },
  );

  assert.equal(result.success, true);
  assert.deepEqual(client.addedTabs[0], {
    spreadsheetId: "sheet-1",
    name: "New Tab",
  });
});

test("sheets_find searches Drive and returns ranked matches", async () => {
  const driveClient = new FakeDriveClient();
  const registry = registryWithGooglePack(new FakeSheetsClient(), driveClient);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  const result = await executor.execute(
    "sheets_find",
    { query: "expenses 2026" },
    context,
    { userAuthorized: true },
  );

  assert.deepEqual(result, { success: true, data: { matches: driveClient.matches } });
  assert.equal(driveClient.queries.length, 1);
  const summary = registry.list().find((skill) => skill.name === "sheets_find");
  assert.deepEqual(summary?.execution, { mutability: "read", impact: "normal" });
});

test("all sheets skills report unavailable and configured=false when their client isn't set up", async () => {
  const registry = registryWithGooglePack(undefined, undefined);
  const executor = new SkillExecutor(registry, new ExecutionPolicyEngine());

  for (const skill of [
    "sheets_create",
    "sheets_read",
    "sheets_update",
    "sheets_add_tab",
    "sheets_find",
  ] as const) {
    const summary = registry.list().find((entry) => entry.name === skill);
    assert.equal(summary?.configured, false, skill);
  }

  const sheetsResult = await executor.execute(
    "sheets_create",
    { title: "T", tabs: [{ name: "S", headers: ["A"] }] },
    context,
    { userAuthorized: true },
  );
  assert.equal(sheetsResult.success, false);
  if (!sheetsResult.success) {
    assert.equal(sheetsResult.error.code, "GOOGLE_SHEETS_UNAVAILABLE");
  }

  const findResult = await executor.execute(
    "sheets_find",
    { query: "x" },
    context,
    { userAuthorized: true },
  );
  assert.equal(findResult.success, false);
  if (!findResult.success) {
    assert.equal(findResult.error.code, "GOOGLE_DRIVE_UNAVAILABLE");
  }
});

test("the google pack groups all five sheets skills", () => {
  const registry = registryWithGooglePack(new FakeSheetsClient(), new FakeDriveClient());
  const packs = registry.listPacks();
  const google = packs.find((pack) => pack.name === "google");
  assert.equal(google?.skillCount, 5);
  assert.equal(google?.configured, true);
});

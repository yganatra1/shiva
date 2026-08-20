import assert from "node:assert/strict";
import { test } from "node:test";

import { getTableColumns } from "drizzle-orm";

import type { ShivaDatabase } from "../src/database/pool.js";
import { expenseSheetBindings } from "../src/database/schema.js";
import {
  DrizzleExpenseSheetBindingStore,
} from "../src/tools/expenses/sheet-binding-repository.js";
import type { ExpenseSheetBinding } from "../src/tools/expenses/sheet-binding.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LEASE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-20T10:00:00.000Z");
const LEASE_EXPIRY = new Date("2026-08-20T10:01:00.000Z");

interface FakeDatabaseScript {
  readonly inserts?: readonly (readonly ExpenseSheetBinding[])[];
  readonly updates?: readonly (readonly ExpenseSheetBinding[])[];
  readonly selects?: readonly (readonly ExpenseSheetBinding[])[];
}

interface FakeDatabaseCalls {
  readonly insertedValues: unknown[];
  readonly updateSets: unknown[];
  insertCount: number;
  updateCount: number;
  selectCount: number;
}

test("binding schema persists only external resource and provisioning metadata", () => {
  assert.deepEqual(Object.keys(getTableColumns(expenseSheetBindings)), [
    "userId",
    "spreadsheetId",
    "sheetId",
    "status",
    "schemaVersion",
    "leaseOwner",
    "leaseExpiresAt",
    "createdAt",
    "updatedAt",
  ]);
});

test("a first claimant atomically reserves the user binding and bootstrap ID", async () => {
  const claimed = binding({
    spreadsheetId: "bootstrap_sheet_123",
    leaseOwner: LEASE_ID,
    leaseExpiresAt: LEASE_EXPIRY,
  });
  const { database, calls } = fakeDatabase({ inserts: [[claimed]] });
  const store = new DrizzleExpenseSheetBindingStore(database);

  const result = await store.claimProvisioning({
    userId: USER_ID,
    leaseOwner: LEASE_ID,
    now: NOW,
    leaseExpiresAt: LEASE_EXPIRY,
    bootstrapSpreadsheetId: "bootstrap_sheet_123",
  });

  assert.deepEqual(result, { state: "claimed", binding: claimed });
  assert.equal(calls.insertCount, 1);
  assert.equal(calls.updateCount, 0);
  assert.equal(calls.selectCount, 0);
  assert.deepEqual(calls.insertedValues, [
    {
      userId: USER_ID,
      spreadsheetId: "bootstrap_sheet_123",
      status: "provisioning",
      leaseOwner: LEASE_ID,
      leaseExpiresAt: LEASE_EXPIRY,
      updatedAt: NOW,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(calls.insertedValues), /amount|description|credential/i);
});

test("claim reports an active competing lease as busy", async () => {
  const busy = binding({
    leaseOwner: OTHER_LEASE_ID,
    leaseExpiresAt: LEASE_EXPIRY,
  });
  const { database, calls } = fakeDatabase({
    inserts: [[]],
    updates: [[]],
    selects: [[busy]],
  });
  const store = new DrizzleExpenseSheetBindingStore(database);

  const result = await store.claimProvisioning({
    userId: USER_ID,
    leaseOwner: LEASE_ID,
    now: NOW,
    leaseExpiresAt: LEASE_EXPIRY,
  });

  assert.deepEqual(result, { state: "busy", binding: busy });
  assert.equal(calls.insertCount, 1);
  assert.equal(calls.updateCount, 1);
  assert.equal(calls.selectCount, 1);
});

test("claim returns an already-ready current binding without taking its lease", async () => {
  const ready = binding({
    spreadsheetId: "ready_sheet_123",
    sheetId: 42,
    status: "ready",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  const { database } = fakeDatabase({
    inserts: [[]],
    updates: [[]],
    selects: [[ready]],
  });
  const store = new DrizzleExpenseSheetBindingStore(database);

  assert.deepEqual(
    await store.claimProvisioning({
      userId: USER_ID,
      leaseOwner: LEASE_ID,
      now: NOW,
      leaseExpiresAt: LEASE_EXPIRY,
    }),
    { state: "ready", binding: ready },
  );
});

test("spreadsheet attachment and ready transition are lease-owned CAS mutations", async () => {
  const attached = binding({
    spreadsheetId: "created_sheet_123",
    leaseOwner: LEASE_ID,
    leaseExpiresAt: LEASE_EXPIRY,
  });
  const ready = binding({
    spreadsheetId: "created_sheet_123",
    sheetId: 7,
    status: "ready",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  const { database, calls } = fakeDatabase({ updates: [[attached], [ready]] });
  const store = new DrizzleExpenseSheetBindingStore(database);

  assert.deepEqual(
    await store.attachSpreadsheetId({
      userId: USER_ID,
      leaseOwner: LEASE_ID,
      spreadsheetId: "created_sheet_123",
      now: NOW,
    }),
    attached,
  );
  assert.deepEqual(
    await store.markReady({
      userId: USER_ID,
      leaseOwner: LEASE_ID,
      spreadsheetId: "created_sheet_123",
      sheetId: 7,
      schemaVersion: 1,
      now: NOW,
    }),
    ready,
  );

  assert.deepEqual(calls.updateSets, [
    { spreadsheetId: "created_sheet_123", updatedAt: NOW },
    {
      status: "ready",
      sheetId: 7,
      schemaVersion: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: NOW,
    },
  ]);
});

test("claim release is conditional and invalid IDs fail before database access", async () => {
  const { database, calls } = fakeDatabase({ updates: [[binding()], []] });
  const store = new DrizzleExpenseSheetBindingStore(database);

  assert.equal(
    await store.releaseClaim({ userId: USER_ID, leaseOwner: LEASE_ID, now: NOW }),
    true,
  );
  assert.equal(
    await store.releaseClaim({ userId: USER_ID, leaseOwner: LEASE_ID, now: NOW }),
    false,
  );
  await assert.rejects(
    store.claimProvisioning({
      userId: "not-a-uuid",
      leaseOwner: LEASE_ID,
      now: NOW,
      leaseExpiresAt: LEASE_EXPIRY,
    }),
    /userId must be a UUID/,
  );
  assert.equal(calls.insertCount, 0);
  assert.equal(calls.updateCount, 2);
});

function binding(
  overrides: Partial<ExpenseSheetBinding> = {},
): ExpenseSheetBinding {
  return {
    userId: USER_ID,
    spreadsheetId: null,
    sheetId: null,
    status: "provisioning",
    schemaVersion: 1,
    leaseOwner: LEASE_ID,
    leaseExpiresAt: LEASE_EXPIRY,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fakeDatabase(script: FakeDatabaseScript): {
  readonly database: ShivaDatabase;
  readonly calls: FakeDatabaseCalls;
} {
  const insertResults = [...(script.inserts ?? [])];
  const updateResults = [...(script.updates ?? [])];
  const selectResults = [...(script.selects ?? [])];
  const calls: FakeDatabaseCalls = {
    insertedValues: [],
    updateSets: [],
    insertCount: 0,
    updateCount: 0,
    selectCount: 0,
  };

  const database = {
    insert: () => ({
      values: (values: unknown) => {
        calls.insertCount += 1;
        calls.insertedValues.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: async () => insertResults.shift() ?? [],
          }),
        };
      },
    }),
    update: () => ({
      set: (values: unknown) => {
        calls.updateCount += 1;
        calls.updateSets.push(values);
        return {
          where: () => ({
            returning: async () => updateResults.shift() ?? [],
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            calls.selectCount += 1;
            return selectResults.shift() ?? [];
          },
        }),
      }),
    }),
  } as unknown as ShivaDatabase;

  return { database, calls };
}

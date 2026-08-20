import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPENSE_SHEET_COLUMNS,
  GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES,
  GoogleSheetsExpenseError,
  type GoogleAccessTokenProvider,
} from "../src/tools/expenses/google-sheets.js";
import {
  EXPENSE_SHEET_TITLE,
  EXPENSE_SPREADSHEET_TITLE,
  ManagedGoogleSheetsExpenseRepository,
} from "../src/tools/expenses/google-sheets-manager.js";
import {
  EXPENSE_SHEET_SCHEMA_VERSION,
  type AttachExpenseSpreadsheetInput,
  type ClaimExpenseSheetBindingInput,
  type ExpenseSheetBinding,
  type ExpenseSheetBindingClaim,
  type ExpenseSheetBindingStore,
  type MarkExpenseSheetReadyInput,
  type ReleaseExpenseSheetClaimInput,
} from "../src/tools/expenses/sheet-binding.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_OWNER = "22222222-2222-4222-8222-222222222222";
const SPREADSHEET_ID = "shiva-expenses-sheet-1";
const SHEET_ID = 731;
const HEADER = [...EXPENSE_SHEET_COLUMNS];

class FakeTokenProvider implements GoogleAccessTokenProvider {
  calls = 0;

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    this.calls += 1;
    signal?.throwIfAborted();
    return "private-user-token";
  }
}

class MemoryBindingStore implements ExpenseSheetBindingStore {
  binding: ExpenseSheetBinding | null = null;
  claimCalls = 0;
  attachCalls = 0;
  readyCalls = 0;
  releaseCalls = 0;

  async get(userId: string): Promise<ExpenseSheetBinding | null> {
    return this.binding?.userId === userId ? this.binding : null;
  }

  async claimProvisioning(
    input: ClaimExpenseSheetBindingInput,
  ): Promise<ExpenseSheetBindingClaim> {
    this.claimCalls += 1;
    if (!this.binding) {
      this.binding = binding({
        userId: input.userId,
        spreadsheetId: input.bootstrapSpreadsheetId ?? null,
        status: "provisioning",
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      });
      return { state: "claimed", binding: this.binding };
    }
    if (this.binding.status === "ready") {
      return { state: "ready", binding: this.binding };
    }
    if (
      this.binding.leaseOwner === input.leaseOwner ||
      !this.binding.leaseExpiresAt ||
      this.binding.leaseExpiresAt <= input.now
    ) {
      this.binding = {
        ...this.binding,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      return { state: "claimed", binding: this.binding };
    }
    return { state: "busy", binding: this.binding };
  }

  async attachSpreadsheetId(
    input: AttachExpenseSpreadsheetInput,
  ): Promise<ExpenseSheetBinding | null> {
    this.attachCalls += 1;
    if (
      !this.binding ||
      this.binding.userId !== input.userId ||
      this.binding.leaseOwner !== input.leaseOwner
    ) {
      return null;
    }
    this.binding = {
      ...this.binding,
      spreadsheetId: input.spreadsheetId,
      updatedAt: input.now,
    };
    return this.binding;
  }

  async markReady(
    input: MarkExpenseSheetReadyInput,
  ): Promise<ExpenseSheetBinding | null> {
    this.readyCalls += 1;
    if (
      !this.binding ||
      this.binding.userId !== input.userId ||
      this.binding.leaseOwner !== input.leaseOwner ||
      this.binding.spreadsheetId !== input.spreadsheetId
    ) {
      return null;
    }
    this.binding = {
      ...this.binding,
      sheetId: input.sheetId,
      status: "ready",
      schemaVersion: input.schemaVersion,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    };
    return this.binding;
  }

  async releaseClaim(
    input: ReleaseExpenseSheetClaimInput,
  ): Promise<boolean> {
    this.releaseCalls += 1;
    if (!this.binding || this.binding.leaseOwner !== input.leaseOwner) {
      return false;
    }
    this.binding = {
      ...this.binding,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    };
    return true;
  }
}

test("concurrent first reads create one canonical sheet and still read rows afresh", async () => {
  const store = new MemoryBindingStore();
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  let createCalls = 0;
  let fullReadCalls = 0;
  const manager = createManager(store, async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const path = decodeURIComponent(url.pathname);

    if (path === "/v4/spreadsheets" && init?.method === "POST") {
      createCalls += 1;
      return spreadsheetResponse();
    }
    if (path.endsWith(`/values/${EXPENSE_SHEET_TITLE}!A1:G1`)) {
      return jsonResponse({ values: [HEADER] });
    }
    if (path.endsWith(`/values/${EXPENSE_SHEET_TITLE}!A:G`)) {
      fullReadCalls += 1;
      return jsonResponse({ values: [HEADER] });
    }
    return jsonResponse({}, 500);
  });

  const [first, second] = await Promise.all([
    manager.listExpenses({ userId: USER_ID }),
    manager.listExpenses({ userId: USER_ID }),
  ]);

  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(createCalls, 1);
  assert.equal(fullReadCalls, 2);
  assert.equal(store.claimCalls, 1);
  assert.equal(store.attachCalls, 1);
  assert.equal(store.readyCalls, 1);
  assert.equal(store.binding?.spreadsheetId, SPREADSHEET_ID);
  assert.equal(store.binding?.sheetId, SHEET_ID);
  assert.equal(store.binding?.schemaVersion, EXPENSE_SHEET_SCHEMA_VERSION);

  const create = requests.find(
    ({ url, init }) => url.pathname === "/v4/spreadsheets" && init?.method === "POST",
  );
  assert.ok(create);
  const body = JSON.parse(String(create.init?.body)) as {
    properties: { title: string };
    sheets: Array<{
      properties: {
        title: string;
        gridProperties: { frozenRowCount: number };
      };
      data: Array<{
        rowData: Array<{
          values: Array<{ userEnteredValue: { stringValue: string } }>;
        }>;
      }>;
    }>;
  };
  assert.equal(body.properties.title, EXPENSE_SPREADSHEET_TITLE);
  assert.equal(body.sheets[0]?.properties.title, EXPENSE_SHEET_TITLE);
  assert.equal(body.sheets[0]?.properties.gridProperties.frozenRowCount, 1);
  assert.deepEqual(
    body.sheets[0]?.data[0]?.rowData[0]?.values.map(
      (cell) => cell.userEnteredValue.stringValue,
    ),
    HEADER,
  );
  for (const request of requests) {
    assert.equal(
      new Headers(request.init?.headers).get("authorization"),
      "Bearer private-user-token",
    );
  }
});

test("a ready binding is verified and reused without creating a spreadsheet", async () => {
  const store = new MemoryBindingStore();
  store.binding = binding({
    spreadsheetId: SPREADSHEET_ID,
    sheetId: SHEET_ID,
    status: "ready",
    schemaVersion: EXPENSE_SHEET_SCHEMA_VERSION,
  });
  let createCalls = 0;
  let metadataCalls = 0;
  const manager = createManager(store, async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    if (path === "/v4/spreadsheets") {
      createCalls += 1;
      return jsonResponse({}, 500);
    }
    if (path === `/v4/spreadsheets/${SPREADSHEET_ID}`) {
      metadataCalls += 1;
      return spreadsheetResponse();
    }
    if (path.endsWith("!A1:G1")) return jsonResponse({ values: [HEADER] });
    if (path.endsWith("!A:G")) return jsonResponse({ values: [HEADER] });
    assert.fail(`unexpected request ${init?.method ?? "GET"} ${url.href}`);
  });

  await manager.listExpenses({ userId: USER_ID });
  await manager.listExpenses({ userId: USER_ID });

  assert.equal(createCalls, 0);
  assert.equal(metadataCalls, 1);
  assert.equal(store.claimCalls, 1);
  assert.equal(store.readyCalls, 0);
});

test("an externally emptied ready binding fails closed without rewriting it", async () => {
  const store = new MemoryBindingStore();
  store.binding = binding({
    spreadsheetId: SPREADSHEET_ID,
    sheetId: SHEET_ID,
    status: "ready",
    schemaVersion: EXPENSE_SHEET_SCHEMA_VERSION,
  });
  let mutationCalls = 0;
  const manager = createManager(store, async (input, init) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    if (init?.method === "POST" || init?.method === "PUT") {
      mutationCalls += 1;
    }
    if (path === `/v4/spreadsheets/${SPREADSHEET_ID}`) {
      return spreadsheetResponse();
    }
    if (path.endsWith("!A1:G1")) {
      return jsonResponse({ range: `${EXPENSE_SHEET_TITLE}!A1:G1` });
    }
    return jsonResponse({}, 500);
  });

  await assert.rejects(
    manager.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_RESPONSE",
  );
  assert.equal(mutationCalls, 0);
  assert.equal(store.readyCalls, 0);
});

test("a bootstrap spreadsheet is adopted, frozen, verified, and persisted", async () => {
  const store = new MemoryBindingStore();
  let batchUpdateCalls = 0;
  const manager = createManager(
    store,
    async (input, init) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      if (path === `/v4/spreadsheets/${SPREADSHEET_ID}`) {
        return spreadsheetResponse(0);
      }
      if (path.endsWith("!A1:G1")) return jsonResponse({ values: [HEADER] });
      if (path.endsWith(":batchUpdate")) {
        batchUpdateCalls += 1;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: SHEET_ID,
                  gridProperties: { frozenRowCount: 1 },
                },
                fields: "gridProperties.frozenRowCount",
              },
            },
          ],
        });
        return jsonResponse({ replies: [{}] });
      }
      if (path.endsWith("!A:G")) return jsonResponse({ values: [HEADER] });
      assert.fail(`unexpected request ${init?.method ?? "GET"} ${url.href}`);
    },
    SPREADSHEET_ID,
  );

  await manager.listExpenses({ userId: USER_ID });

  assert.equal(batchUpdateCalls, 1);
  assert.equal(store.attachCalls, 0);
  assert.equal(store.readyCalls, 1);
  assert.equal(store.binding?.spreadsheetId, SPREADSHEET_ID);
  assert.equal(store.binding?.status, "ready");
});

test("adoption fails closed on a noncanonical header and releases its claim", async () => {
  const store = new MemoryBindingStore();
  const manager = createManager(
    store,
    async (input) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      if (path === `/v4/spreadsheets/${SPREADSHEET_ID}`) {
        return spreadsheetResponse();
      }
      if (path.endsWith("!A1:G1")) {
        return jsonResponse({ values: [["date", "cost", "notes"]] });
      }
      return jsonResponse({}, 500);
    },
    SPREADSHEET_ID,
  );

  await assert.rejects(
    manager.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_RESPONSE" &&
      !/date|cost|notes/.test(error.message),
  );
  assert.equal(store.readyCalls, 0);
  assert.equal(store.releaseCalls, 1);
});

test("an adopted empty spreadsheet gets the managed tab and canonical header", async () => {
  const store = new MemoryBindingStore();
  let headerReads = 0;
  let headerWrites = 0;
  let addTabCalls = 0;
  let fullReads = 0;
  const manager = createManager(
    store,
    async (input, init) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      if (path === `/v4/spreadsheets/${SPREADSHEET_ID}`) {
        return jsonResponse({
          spreadsheetId: SPREADSHEET_ID,
          sheets: [
            {
              properties: {
                sheetId: 1,
                title: "Sheet1",
                gridProperties: { frozenRowCount: 0 },
              },
            },
          ],
        });
      }
      if (path.endsWith(":batchUpdate")) {
        addTabCalls += 1;
        const body = JSON.parse(String(init?.body)) as {
          requests: Array<{
            addSheet: { properties: { title: string; gridProperties: object } };
          }>;
        };
        assert.equal(
          body.requests[0]?.addSheet.properties.title,
          EXPENSE_SHEET_TITLE,
        );
        return jsonResponse({
          replies: [
            {
              addSheet: {
                properties: {
                  sheetId: SHEET_ID,
                  title: EXPENSE_SHEET_TITLE,
                  gridProperties: { frozenRowCount: 1 },
                },
              },
            },
          ],
        });
      }
      if (path.endsWith("!A1:G1") && init?.method === "PUT") {
        headerWrites += 1;
        assert.deepEqual(JSON.parse(String(init.body)), {
          majorDimension: "ROWS",
          values: [HEADER],
        });
        return jsonResponse({ updatedRange: `${EXPENSE_SHEET_TITLE}!A1:G1` });
      }
      if (path.endsWith("!A1:G1")) {
        headerReads += 1;
        return headerReads === 1
          ? jsonResponse({ range: `${EXPENSE_SHEET_TITLE}!A1:G1` })
          : jsonResponse({ values: [HEADER] });
      }
      if (path.endsWith("!A:G")) {
        fullReads += 1;
        return fullReads === 1
          ? jsonResponse({ range: `${EXPENSE_SHEET_TITLE}!A:G` })
          : jsonResponse({ values: [HEADER] });
      }
      assert.fail(`unexpected request ${init?.method ?? "GET"} ${url.href}`);
    },
    SPREADSHEET_ID,
  );

  await manager.listExpenses({ userId: USER_ID });

  assert.equal(addTabCalls, 1);
  assert.equal(headerWrites, 1);
  assert.equal(headerReads, 2);
  assert.equal(fullReads, 2);
  assert.equal(store.binding?.sheetId, SHEET_ID);
  assert.equal(store.binding?.status, "ready");
});

test("an empty header above existing data is never initialized or overwritten", async () => {
  const store = new MemoryBindingStore();
  let mutationCalls = 0;
  const manager = createManager(
    store,
    async (input, init) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      if (init?.method === "POST" || init?.method === "PUT") {
        mutationCalls += 1;
      }
      if (path === `/v4/spreadsheets/${SPREADSHEET_ID}`) {
        return spreadsheetResponse();
      }
      if (path.endsWith("!A1:G1")) {
        return jsonResponse({ range: `${EXPENSE_SHEET_TITLE}!A1:G1` });
      }
      if (path.endsWith("!A:G")) {
        return jsonResponse({ values: [[], ["orphaned-existing-row"]] });
      }
      return jsonResponse({}, 500);
    },
    SPREADSHEET_ID,
  );

  await assert.rejects(
    manager.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_RESPONSE",
  );
  assert.equal(mutationCalls, 0);
  assert.equal(store.readyCalls, 0);
  assert.equal(store.releaseCalls, 1);
});

test("a durable binding conflicting with the bootstrap ID is rejected before Google access", async () => {
  const store = new MemoryBindingStore();
  store.binding = binding({
    spreadsheetId: "different-sheet-id",
    sheetId: SHEET_ID,
    status: "ready",
    schemaVersion: EXPENSE_SHEET_SCHEMA_VERSION,
  });
  let fetchCalls = 0;
  const manager = createManager(
    store,
    async () => {
      fetchCalls += 1;
      return jsonResponse({}, 500);
    },
    SPREADSHEET_ID,
  );

  await assert.rejects(
    manager.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_RESPONSE",
  );
  assert.equal(fetchCalls, 0);
});

test("invalid users and pre-cancelled callers cause no binding or Google side effects", async () => {
  const store = new MemoryBindingStore();
  let fetchCalls = 0;
  const manager = createManager(store, async () => {
    fetchCalls += 1;
    return jsonResponse({}, 500);
  });

  await assert.rejects(
    manager.listExpenses({ userId: "not-a-uuid" }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError && error.failure === "INVALID_INPUT",
  );
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));
  await assert.rejects(
    manager.listExpenses({ userId: USER_ID, signal: controller.signal }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError && error.failure === "CANCELLED",
  );
  assert.equal(store.claimCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("spreadsheet provisioning has a bounded timeout and releases the lease", async () => {
  const store = new MemoryBindingStore();
  const manager = new ManagedGoogleSheetsExpenseRepository({
    bindingStore: store,
    accessTokenProvider: new FakeTokenProvider(),
    requestTimeoutMs: 5,
    leaseDurationMs: 50,
    fetchFunction: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        const fallback = setTimeout(
          () => reject(new Error("mock provisioning request was not aborted")),
          100,
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    apiBaseUrl: "https://sheets.test",
    createLeaseOwner: () => LEASE_OWNER,
  });

  await assert.rejects(
    manager.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError && error.failure === "TIMEOUT",
  );
  assert.equal(store.releaseCalls, 1);
});

test(
  "a never-resolving best-effort lease release cannot extend the provisioning timeout",
  { timeout: 500 },
  async () => {
    class NeverResolvingReleaseStore extends MemoryBindingStore {
      override releaseClaim(
        _input: ReleaseExpenseSheetClaimInput,
      ): Promise<boolean> {
        this.releaseCalls += 1;
        return new Promise<boolean>(() => undefined);
      }
    }

    const store = new NeverResolvingReleaseStore();
    const manager = new ManagedGoogleSheetsExpenseRepository({
      bindingStore: store,
      accessTokenProvider: new FakeTokenProvider(),
      requestTimeoutMs: 5,
      leaseDurationMs: 50,
      fetchFunction: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert.ok(signal);
          const fallback = setTimeout(
            () => reject(new Error("mock provisioning request was not aborted")),
            100,
          );
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      apiBaseUrl: "https://sheets.test",
      createLeaseOwner: () => LEASE_OWNER,
    });
    const startedAt = performance.now();

    await assert.rejects(
      manager.listExpenses({ userId: USER_ID }),
      (error: unknown) =>
        error instanceof GoogleSheetsExpenseError && error.failure === "TIMEOUT",
    );

    assert.equal(store.releaseCalls, 1);
    assert.ok(
      performance.now() - startedAt < 250,
      "best-effort cleanup must not hold the provisioning result open",
    );
  },
);

test("spreadsheet provisioning rejects an oversized Google JSON response", async () => {
  const store = new MemoryBindingStore();
  const manager = createManager(store, async () =>
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES + 1),
      },
    }),
  );

  await assert.rejects(
    manager.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_RESPONSE" &&
      /more than/.test(error.message),
  );
  assert.equal(store.readyCalls, 0);
  assert.equal(store.releaseCalls, 1);
});

function createManager(
  bindingStore: ExpenseSheetBindingStore,
  fetchFunction: typeof fetch,
  bootstrapSpreadsheetId?: string,
): ManagedGoogleSheetsExpenseRepository {
  return new ManagedGoogleSheetsExpenseRepository({
    bindingStore,
    accessTokenProvider: new FakeTokenProvider(),
    requestTimeoutMs: 1_000,
    leaseDurationMs: 2_000,
    busyPollMs: 1,
    fetchFunction,
    apiBaseUrl: "https://sheets.test",
    createExpenseId: () => "expense-1",
    createLeaseOwner: () => LEASE_OWNER,
    ...(bootstrapSpreadsheetId ? { bootstrapSpreadsheetId } : {}),
  });
}

function binding(
  overrides: Partial<ExpenseSheetBinding> = {},
): ExpenseSheetBinding {
  const now = new Date("2026-08-20T00:00:00.000Z");
  return {
    userId: USER_ID,
    spreadsheetId: null,
    sheetId: null,
    status: "provisioning",
    schemaVersion: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function spreadsheetResponse(frozenRowCount = 1): Response {
  return jsonResponse({
    spreadsheetId: SPREADSHEET_ID,
    sheets: [
      {
        properties: {
          sheetId: SHEET_ID,
          title: EXPENSE_SHEET_TITLE,
          gridProperties: { frozenRowCount },
        },
      },
    ],
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPENSE_SHEET_COLUMNS,
  GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES,
  GoogleSheetsExpenseError,
  GoogleSheetsExpenseRepository,
  type GoogleAccessTokenProvider,
} from "../src/tools/expenses/google-sheets.js";

const HEADER = [...EXPENSE_SHEET_COLUMNS];
const EXPENSE_ID = "expense-0001";
const USER_ID = "11111111-1111-4111-8111-111111111111";

class FakeTokenProvider implements GoogleAccessTokenProvider {
  calls = 0;

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    this.calls += 1;
    signal?.throwIfAborted();
    return "private-access-token";
  }
}

test("Google Sheets expense reads are fresh, filtered, sorted, and authenticated", async () => {
  const tokenProvider = new FakeTokenProvider();
  const responses = [
    valuesResponse([
      HEADER,
      ["old", "2026-08-18T10:00:00.000Z", 10.1, "INR", "Coffee", "Food", "manual"],
    ]),
    valuesResponse([
      HEADER,
      ["old", "2026-08-18T10:00:00.000Z", 10.1, "INR", "Coffee", "Food", "manual"],
      ["new", "2026-08-20T10:00:00.000Z", "20.25", "INR", "Lunch", "", "shiva"],
    ]),
  ];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const repository = createRepository(tokenProvider, async (input, init) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, "unexpected Google Sheets request");
    return response;
  });

  const first = await repository.listExpenses({ userId: USER_ID });
  const second = await repository.listExpenses({
    userId: USER_ID,
    from: new Date("2026-08-19T00:00:00Z"),
  });

  assert.equal(first.length, 1);
  assert.deepEqual(second, [
    {
      expenseId: "new",
      occurredAt: new Date("2026-08-20T10:00:00.000Z"),
      amount: "20.25",
      currency: "INR",
      description: "Lunch",
      category: null,
      source: "shiva",
    },
  ]);
  assert.equal(tokenProvider.calls, 2);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(
      decodeURIComponent(new URL(request.url).pathname),
      /\/values\/'Expense Ledger'!A:G$/,
    );
    assert.equal(
      new Headers(request.init?.headers).get("authorization"),
      "Bearer private-access-token",
    );
  }
});

test("append reads the live header and confirms the exact updated range before success", async () => {
  const tokenProvider = new FakeTokenProvider();
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const expectedRow = [
    EXPENSE_ID,
    "2026-08-20T06:30:00.000Z",
    "450.00",
    "INR",
    "Pizza",
    "Food",
    "shiva",
  ];
  const responses = [
    valuesResponse([HEADER]),
    jsonResponse({ updates: { updatedRange: "'Expense Ledger'!A2:G2" } }),
    valuesResponse([expectedRow]),
  ];
  const repository = createRepository(tokenProvider, async (input, init) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, "unexpected Google Sheets request");
    return response;
  });

  const created = await repository.insertExpense({
    userId: USER_ID,
    amount: "450.00",
    currency: "INR",
    description: "Pizza",
    category: "Food",
    occurredAt: new Date("2026-08-20T06:30:00.000Z"),
    source: "shiva",
  });

  assert.deepEqual(created, {
    expenseId: EXPENSE_ID,
    occurredAt: new Date("2026-08-20T06:30:00.000Z"),
    amount: "450.00",
    currency: "INR",
    description: "Pizza",
    category: "Food",
    source: "shiva",
  });
  assert.equal(tokenProvider.calls, 1);
  assert.equal(requests.length, 3);
  const append = requests[1];
  assert.ok(append);
  const appendUrl = new URL(append.url);
  assert.match(decodeURIComponent(appendUrl.pathname), /!A:G:append$/);
  assert.equal(appendUrl.searchParams.get("valueInputOption"), "RAW");
  assert.equal(appendUrl.searchParams.get("insertDataOption"), "INSERT_ROWS");
  assert.deepEqual(JSON.parse(String(append.init?.body)), {
    majorDimension: "ROWS",
    values: [expectedRow],
  });
  assert.match(
    decodeURIComponent(new URL(requests[2]?.url ?? "").pathname),
    /!A2:G2$/,
  );
});

test("append fails closed when the exact read-back does not match", async () => {
  const responses = [
    valuesResponse([HEADER]),
    jsonResponse({ updates: { updatedRange: "'Expense Ledger'!A2:G2" } }),
    valuesResponse([
      [
        EXPENSE_ID,
        "2026-08-20T06:30:00.000Z",
        "999.00",
        "INR",
        "Pizza",
        "Food",
        "shiva",
      ],
    ]),
  ];
  const repository = createRepository(
    new FakeTokenProvider(),
    async () => responses.shift() ?? jsonResponse({}, 500),
  );

  await assert.rejects(
    repository.insertExpense({
      userId: USER_ID,
      amount: "450.00",
      currency: "INR",
      description: "Pizza",
      category: "Food",
      occurredAt: new Date("2026-08-20T06:30:00.000Z"),
      source: "shiva",
    }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "WRITE_NOT_CONFIRMED",
  );
});

test("append validates canonical values before any Google request", async () => {
  let fetchCalls = 0;
  const repository = createRepository(
    new FakeTokenProvider(),
    async () => {
      fetchCalls += 1;
      return valuesResponse([HEADER]);
    },
  );

  await assert.rejects(
    repository.insertExpense({
      userId: USER_ID,
      amount: "450",
      currency: "INR",
      description: "Pizza",
      category: null,
      occurredAt: new Date("2026-08-20T06:30:00.000Z"),
      source: "Shiva",
    }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_INPUT",
  );
  assert.equal(fetchCalls, 0);
});

test("Google Sheets upstream and auth details are mapped to safe typed errors", async () => {
  const repository = createRepository(
    new FakeTokenProvider(),
    async () => jsonResponse({ error: { message: "sensitive provider detail" } }, 403),
  );

  await assert.rejects(
    repository.listExpenses({ userId: USER_ID }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleSheetsExpenseError);
      assert.equal(error.failure, "AUTH");
      assert.doesNotMatch(error.message, /sensitive provider detail/);
      return true;
    },
  );
});

test("Google Sheets rejects an oversized streamed response without Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array(GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES),
      );
      controller.enqueue(new Uint8Array([0x20]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const repository = createRepository(
    new FakeTokenProvider(),
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

  await assert.rejects(
    repository.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError &&
      error.failure === "INVALID_RESPONSE" &&
      /more than/.test(error.message),
  );
  assert.equal(cancelled, true);
});

test("Google Sheets rejects dishonest and over-limit Content-Length headers", async () => {
  const responses = [
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "1",
      },
    }),
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(
          GOOGLE_SHEETS_MAX_JSON_RESPONSE_BYTES + 1,
        ),
      },
    }),
  ];
  const repository = createRepository(
    new FakeTokenProvider(),
    async () => responses.shift() ?? jsonResponse({}, 500),
  );

  for (const expectedMessage of [/inconsistent/, /more than/]) {
    await assert.rejects(
      repository.listExpenses({ userId: USER_ID }),
      (error: unknown) =>
        error instanceof GoogleSheetsExpenseError &&
        error.failure === "INVALID_RESPONSE" &&
        expectedMessage.test(error.message),
    );
  }
});

test("Google Sheets operations distinguish timeout from caller cancellation", async () => {
  const timeoutRepository = new GoogleSheetsExpenseRepository({
    spreadsheetId: "sheet-id",
    sheetRange: "'Expense Ledger'!A:G",
    accessTokenProvider: new FakeTokenProvider(),
    requestTimeoutMs: 5,
    createExpenseId: () => EXPENSE_ID,
    fetchFunction: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        const fallback = setTimeout(
          () => reject(new Error("mock request was not aborted")),
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
  });
  await assert.rejects(
    timeoutRepository.listExpenses({ userId: USER_ID }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError && error.failure === "TIMEOUT",
  );

  let fetchCalls = 0;
  const cancelledRepository = createRepository(
    new FakeTokenProvider(),
    async () => {
      fetchCalls += 1;
      return valuesResponse([HEADER]);
    },
  );
  const controller = new AbortController();
  controller.abort(new Error("client left"));
  await assert.rejects(
    cancelledRepository.listExpenses({
      userId: USER_ID,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof GoogleSheetsExpenseError && error.failure === "CANCELLED",
  );
  assert.equal(fetchCalls, 0);
});

function createRepository(
  accessTokenProvider: GoogleAccessTokenProvider,
  fetchFunction: typeof fetch,
): GoogleSheetsExpenseRepository {
  return new GoogleSheetsExpenseRepository({
    spreadsheetId: "sheet-id",
    sheetRange: "'Expense Ledger'!A:G",
    accessTokenProvider,
    requestTimeoutMs: 1_000,
    fetchFunction,
    createExpenseId: () => EXPENSE_ID,
  });
}

function valuesResponse(values: readonly (readonly unknown[])[]): Response {
  return jsonResponse({ range: "'Expense Ledger'!A:G", values });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

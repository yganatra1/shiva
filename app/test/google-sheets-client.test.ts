import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GoogleSheetsClient,
  SheetsClientError,
  sheetsErrorToFailure,
  type GoogleAccessTokenProvider,
} from "../src/tools/sheets/client.js";

class FakeTokenProvider implements GoogleAccessTokenProvider {
  calls = 0;

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    this.calls += 1;
    signal?.throwIfAborted();
    return "private-access-token";
  }
}

function client(fetchFunction: typeof fetch, tokenProvider = new FakeTokenProvider()) {
  return new GoogleSheetsClient({
    accessTokenProvider: tokenProvider,
    requestTimeoutMs: 1_000,
    fetchFunction,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("createSpreadsheet sends every tab, its rows, and header formatting in one call", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sheets = client(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123",
      sheets: [
        { properties: { title: "January", sheetId: 1 } },
        { properties: { title: "February", sheetId: 2 } },
      ],
    });
  });

  const result = await sheets.createSpreadsheet({
    title: "Expenses 2026",
    tabs: [
      {
        name: "January",
        headers: ["Date", "Category", "Amount"],
        rows: [["2026-01-05", "Food", 12.5]],
        columnOptions: { Category: ["Food", "Transport"] },
      },
      { name: "February", headers: ["Date", "Category", "Amount"] },
    ],
  });

  assert.deepEqual(result, {
    spreadsheetId: "sheet-123",
    url: "https://docs.google.com/spreadsheets/d/sheet-123",
    tabs: [
      { name: "January", sheetId: 1 },
      { name: "February", sheetId: 2 },
    ],
  });
  // One create call plus one batchUpdate call for the January dropdown.
  assert.equal(requests.length, 2);
  const createRequest = requests[0];
  assert.ok(createRequest);
  assert.equal(
    new Headers(createRequest.init?.headers).get("authorization"),
    "Bearer private-access-token",
  );
  const body = JSON.parse(String(createRequest.init?.body)) as {
    properties: { title: string };
    sheets: Array<{
      properties: { title: string; gridProperties: { frozenRowCount: number } };
      data: Array<{ rowData: Array<{ values: unknown[] }> }>;
    }>;
  };
  assert.equal(body.properties.title, "Expenses 2026");
  assert.equal(body.sheets.length, 2);
  assert.equal(body.sheets[0]?.properties.title, "January");
  assert.equal(body.sheets[0]?.properties.gridProperties.frozenRowCount, 1);
  assert.equal(body.sheets[0]?.data[0]?.rowData.length, 2);
  const headerCells = body.sheets[0]?.data[0]?.rowData[0]?.values as Array<{
    userEnteredFormat: { textFormat: { bold: boolean } };
  }>;
  assert.equal(headerCells[0]?.userEnteredFormat.textFormat.bold, true);

  const validationRequest = requests[1];
  assert.ok(validationRequest);
  assert.match(validationRequest.url, /:batchUpdate$/);
  const validationBody = JSON.parse(String(validationRequest.init?.body)) as {
    requests: Array<{
      setDataValidation: {
        range: { sheetId: number; startColumnIndex: number; endColumnIndex: number };
        rule: { condition: { type: string; values: Array<{ userEnteredValue: string }> } };
      };
    }>;
  };
  const validation = validationBody.requests[0]?.setDataValidation;
  assert.equal(validation?.range.sheetId, 1); // January's sheetId
  assert.equal(validation?.range.startColumnIndex, 1); // "Category" is header index 1
  assert.equal(validation?.rule.condition.type, "ONE_OF_LIST");
  assert.deepEqual(
    validation?.rule.condition.values.map((value) => value.userEnteredValue),
    ["Food", "Transport"],
  );
});

test("createSpreadsheet rejects empty, duplicate, or oversized headers before any request", async () => {
  let called = false;
  const sheets = client(async () => {
    called = true;
    return jsonResponse({});
  });

  await assert.rejects(
    () =>
      sheets.createSpreadsheet({
        title: "T",
        tabs: [{ name: "S", headers: ["A", "a"] }],
      }),
    SheetsClientError,
  );
  assert.equal(called, false);
});

test("createSpreadsheet rejects duplicate tab names and columnOptions referencing an unknown header", async () => {
  const sheets = client(async () => jsonResponse({}));

  await assert.rejects(
    () =>
      sheets.createSpreadsheet({
        title: "T",
        tabs: [
          { name: "Jan", headers: ["A"] },
          { name: "jan", headers: ["A"] },
        ],
      }),
    SheetsClientError,
  );
  await assert.rejects(
    () =>
      sheets.createSpreadsheet({
        title: "T",
        tabs: [
          {
            name: "Jan",
            headers: ["A"],
            columnOptions: { NotAHeader: ["x"] },
          },
        ],
      }),
    SheetsClientError,
  );
});

test("addTab adds a sheet, writes its header/rows, and applies its dropdowns", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sheets = client(async (input, init) => {
    requests.push({ url: String(input), init });
    const url = String(input);
    if (url.endsWith(":batchUpdate") && requests.length === 1) {
      return jsonResponse({
        replies: [{ addSheet: { properties: { sheetId: 7, title: "March" } } }],
      });
    }
    return jsonResponse({ updatedRange: "March!A1:B2", updatedRows: 2, updatedColumns: 2 });
  });

  const tab = await sheets.addTab({
    spreadsheetId: "sheet-123",
    name: "March",
    headers: ["Date", "Category"],
    rows: [["2026-03-01", "Food"]],
    columnOptions: { Category: ["Food", "Transport"] },
  });

  assert.deepEqual(tab, { name: "March", sheetId: 7 });
  // addSheet batchUpdate, header/rows PUT, dropdown batchUpdate.
  assert.equal(requests.length, 3);
  assert.match(requests[0]?.url ?? "", /:batchUpdate$/);
  assert.equal(requests[1]?.init?.method, "PUT");
  assert.match(requests[2]?.url ?? "", /:batchUpdate$/);
});

test("getValues normalizes rows and passes through an empty result", async () => {
  const sheets = client(async () =>
    jsonResponse({ range: "Sheet1!A1:B2", values: [["a", 1], ["b", null]] }),
  );

  const result = await sheets.getValues({
    spreadsheetId: "sheet-123",
    range: "Sheet1!A1:B2",
  });

  assert.deepEqual(result, {
    range: "Sheet1!A1:B2",
    values: [
      ["a", 1],
      ["b", null],
    ],
  });
});

test("writeValues appends with USER_ENTERED input and returns the updated range", async () => {
  const requests: Array<{ url: string }> = [];
  const sheets = client(async (input) => {
    requests.push({ url: String(input) });
    return jsonResponse({
      updates: { updatedRange: "Sheet1!A5:C5", updatedRows: 1, updatedColumns: 3 },
    });
  });

  const result = await sheets.writeValues({
    spreadsheetId: "sheet-123",
    range: "Sheet1!A1:C1",
    values: [["2026-08-22", "Coffee", 4.5]],
    mode: "append",
  });

  assert.deepEqual(result, {
    updatedRange: "Sheet1!A5:C5",
    updatedRows: 1,
    updatedColumns: 3,
  });
  assert.match(requests[0]?.url ?? "", /:append/);
  assert.match(requests[0]?.url ?? "", /valueInputOption=USER_ENTERED/);
});

test("writeValues in update mode PUTs the exact range without :append", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sheets = client(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      updatedRange: "Sheet1!A1:A1",
      updatedRows: 1,
      updatedColumns: 1,
    });
  });

  await sheets.writeValues({
    spreadsheetId: "sheet-123",
    range: "Sheet1!A1",
    values: [["fixed"]],
    mode: "update",
  });

  assert.equal(requests[0]?.init?.method, "PUT");
  assert.doesNotMatch(requests[0]?.url ?? "", /:append/);
});

test("a 401/403 response maps to AUTH and a 404 maps to invalid input", async () => {
  const unauthorized = client(async () => new Response("no", { status: 403 }));
  await assert.rejects(
    () => unauthorized.getValues({ spreadsheetId: "sheet-123", range: "Sheet1" }),
    (error: unknown) => error instanceof SheetsClientError && error.failure === "AUTH",
  );

  const missing = client(async () => new Response("no", { status: 404 }));
  await assert.rejects(
    () => missing.getValues({ spreadsheetId: "sheet-123", range: "Sheet1" }),
    (error: unknown) =>
      error instanceof SheetsClientError && error.failure === "INVALID_INPUT",
  );
});

test("sheetsErrorToFailure maps every failure kind and rethrows anything else", () => {
  assert.deepEqual(
    sheetsErrorToFailure(new SheetsClientError("INVALID_INPUT", "bad input")),
    { code: "SHEETS_INVALID_INPUT", message: "bad input" },
  );
  assert.equal(
    sheetsErrorToFailure(new SheetsClientError("AUTH", "x")).code,
    "SHEETS_AUTH_FAILED",
  );
  assert.equal(
    sheetsErrorToFailure(new SheetsClientError("TIMEOUT", "x")).code,
    "SHEETS_TIMEOUT",
  );
  assert.equal(
    sheetsErrorToFailure(new SheetsClientError("INVALID_RESPONSE", "x")).code,
    "SHEETS_INVALID_RESPONSE",
  );
  assert.equal(
    sheetsErrorToFailure(new SheetsClientError("UNAVAILABLE", "x")).code,
    "SHEETS_UNAVAILABLE",
  );
  assert.throws(() => sheetsErrorToFailure(new Error("not a sheets error")));
});

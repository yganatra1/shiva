import assert from "node:assert/strict";
import { test } from "node:test";

import { GoogleDriveClient } from "../src/tools/drive/client.js";

function fakeFetch(capture: { url?: URL }): typeof fetch {
  const impl: typeof fetch = async (input) => {
    capture.url = new URL(String(input));
    return new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl;
}

function client(capture: { url?: URL }): GoogleDriveClient {
  return new GoogleDriveClient({
    accessTokenProvider: { getAccessToken: async () => "token" },
    requestTimeoutMs: 5_000,
    fetchFunction: fakeFetch(capture),
  });
}

test("findSpreadsheets splits a spaced query into OR'd word clauses", async () => {
  const capture: { url?: URL } = {};
  await client(capture).findSpreadsheets({ query: "Expense 2026" });
  const q = capture.url?.searchParams.get("q") ?? "";
  assert.match(q, /name contains 'Expense'/);
  assert.match(q, /name contains '2026'/);
  assert.match(q, / or /);
});

test("findSpreadsheets splits a squished query at letter/digit boundaries", async () => {
  const capture: { url?: URL } = {};
  await client(capture).findSpreadsheets({ query: "Expense2026" });
  const q = capture.url?.searchParams.get("q") ?? "";
  assert.match(q, /name contains 'Expense'/);
  assert.match(q, /name contains '2026'/);
});

test("findSpreadsheets never leaks an unescaped quote into the query", async () => {
  const capture: { url?: URL } = {};
  // Punctuation is a token boundary, same as whitespace, so "O'Brien's" splits
  // into word tokens — none of which can carry a raw quote through to the
  // Drive query string.
  await client(capture).findSpreadsheets({ query: "O'Brien's sheet" });
  const q = capture.url?.searchParams.get("q") ?? "";
  assert.match(q, /name contains 'Brien'/);
  assert.match(q, /name contains 'sheet'/);
});

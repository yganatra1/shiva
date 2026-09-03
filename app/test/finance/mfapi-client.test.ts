import assert from "node:assert/strict";
import { test } from "node:test";

import { MutualFundError } from "../../src/finance/errors.js";
import { MfApiClient } from "../../src/finance/providers/mfapi.client.js";

test("MFapi client retries 429 then succeeds, and does not retry 404", async () => {
  const calls: number[] = [];
  const fetchFunction: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/mf/search")) {
      calls.push(429);
      if (calls.filter((status) => status === 429).length === 1) {
        return new Response("rate", { status: 429 });
      }
      return Response.json([
        { schemeCode: 120503, schemeName: "Axis ELSS Direct Growth" },
      ]);
    }
    calls.push(404);
    return new Response("missing", { status: 404 });
  };
  const client = new MfApiClient({
    baseUrl: "https://api.mfapi.in",
    timeoutMs: 1_000,
    maxRetries: 2,
    fetchFunction,
  });
  const search = await client.searchSchemes("Axis ELSS");
  assert.equal(search[0]?.schemeCode, 120503);

  await assert.rejects(
    () => client.getSchemeHistory(999999),
    (error: unknown) =>
      error instanceof MutualFundError && error.code === "MFAPI_NOT_FOUND",
  );
  assert.equal(calls.filter((status) => status === 404).length, 1);
});

test("scheme codes are validated before any request path is built", async () => {
  let called = false;
  const client = new MfApiClient({
    baseUrl: "https://api.mfapi.in",
    timeoutMs: 1_000,
    maxRetries: 0,
    fetchFunction: async () => {
      called = true;
      return new Response("nope", { status: 200 });
    },
  });
  await assert.rejects(
    () => client.getSchemeHistory(-1),
    (error: unknown) =>
      error instanceof MutualFundError && error.code === "INVALID_SCHEME_CODE",
  );
  assert.equal(called, false);
});

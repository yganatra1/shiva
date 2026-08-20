import assert from "node:assert/strict";
import { test } from "node:test";

import { GoogleSheetsExpenseError } from "../src/tools/expenses/google-sheets.js";
import {
  GoogleUserOAuthAccessTokenProvider,
  type GoogleUserOAuthClientFactory,
  type GoogleUserOAuthTokenClient,
} from "../src/tools/expenses/google-user-oauth.js";

const CLIENT_ID = "oauth-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "oauth-client-secret";
const REFRESH_TOKEN = "oauth-refresh-token";

test("Google user OAuth configures the client and returns a short-lived access token", async () => {
  let factoryOptions: Parameters<GoogleUserOAuthClientFactory>[0] | undefined;
  let configuredRefreshToken: string | undefined;
  const client: GoogleUserOAuthTokenClient = {
    setCredentials(credentials) {
      configuredRefreshToken = credentials.refresh_token;
    },
    async getAccessToken() {
      return { token: "short-lived-access-token" };
    },
  };
  const provider = new GoogleUserOAuthAccessTokenProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
    createClient: (options) => {
      factoryOptions = options;
      return client;
    },
  });

  assert.deepEqual(factoryOptions, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  assert.equal(configuredRefreshToken, REFRESH_TOKEN);
  assert.equal(await provider.getAccessToken(), "short-lived-access-token");
});

test("Google user OAuth rejects incomplete credentials with a sanitized typed error", () => {
  assert.throws(
    () =>
      new GoogleUserOAuthAccessTokenProvider({
        clientId: CLIENT_ID,
        clientSecret: "   ",
        refreshToken: REFRESH_TOKEN,
      }),
    (error: unknown) => {
      assertAuthFailure(error);
      assert.doesNotMatch(error.message, /oauth-client|oauth-refresh/i);
      return true;
    },
  );
});

test("Google user OAuth sanitizes token endpoint failures", async () => {
  const sensitiveDetail = `${CLIENT_SECRET}:${REFRESH_TOKEN}`;
  const provider = createProvider({
    setCredentials() {},
    async getAccessToken() {
      throw new Error(`invalid_grant ${sensitiveDetail}`);
    },
  });

  await assert.rejects(provider.getAccessToken(), (error: unknown) => {
    assertAuthFailure(error);
    assert.doesNotMatch(error.message, /invalid_grant|oauth-client-secret|oauth-refresh-token/i);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("Google user OAuth rejects empty access-token responses as AUTH failures", async () => {
  const provider = createProvider({
    setCredentials() {},
    async getAccessToken() {
      return { token: "  " };
    },
  });

  await assert.rejects(provider.getAccessToken(), (error: unknown) => {
    assertAuthFailure(error);
    return true;
  });
});

test("Google user OAuth stops waiting promptly when token retrieval is cancelled", async () => {
  let resolveToken: ((value: { token: string }) => void) | undefined;
  const tokenRequest = new Promise<{ token: string }>((resolve) => {
    resolveToken = resolve;
  });
  const provider = createProvider({
    setCredentials() {},
    getAccessToken: () => tokenRequest,
  });
  const controller = new AbortController();
  const cancellation = new Error("caller cancelled");
  const result = provider.getAccessToken(controller.signal);

  controller.abort(cancellation);
  await assert.rejects(result, (error: unknown) => error === cancellation);

  // Completing the underlying library request after cancellation must not
  // produce an unhandled rejection or change the already-cancelled result.
  assert.ok(resolveToken);
  resolveToken({ token: "late-access-token" });
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("Google user OAuth does not start retrieval for an already-aborted request", async () => {
  let tokenCalls = 0;
  const provider = createProvider({
    setCredentials() {},
    async getAccessToken() {
      tokenCalls += 1;
      return { token: "unused-token" };
    },
  });
  const controller = new AbortController();
  const cancellation = new Error("already cancelled");
  controller.abort(cancellation);

  await assert.rejects(
    provider.getAccessToken(controller.signal),
    (error: unknown) => error === cancellation,
  );
  assert.equal(tokenCalls, 0);
});

function createProvider(
  client: GoogleUserOAuthTokenClient,
): GoogleUserOAuthAccessTokenProvider {
  return new GoogleUserOAuthAccessTokenProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
    createClient: () => client,
  });
}

function assertAuthFailure(
  error: unknown,
): asserts error is GoogleSheetsExpenseError {
  assert.ok(error instanceof GoogleSheetsExpenseError);
  assert.equal(error.failure, "AUTH");
}

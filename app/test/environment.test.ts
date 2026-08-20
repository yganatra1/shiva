import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConfigurationError,
  loadConfig,
} from "../src/config/environment.js";

test("numeric SHIVA_KEEP_ALIVE values are normalized for the Ollama API", () => {
  const previousValue = process.env.SHIVA_KEEP_ALIVE;

  try {
    process.env.SHIVA_KEEP_ALIVE = "-1";
    assert.equal(loadConfig().keepAlive, -1);

    process.env.SHIVA_KEEP_ALIVE = "0";
    assert.equal(loadConfig().keepAlive, 0);

    process.env.SHIVA_KEEP_ALIVE = "3600";
    assert.equal(loadConfig().keepAlive, 3600);

    process.env.SHIVA_KEEP_ALIVE = "30m";
    assert.equal(loadConfig().keepAlive, "30m");
  } finally {
    if (previousValue === undefined) {
      delete process.env.SHIVA_KEEP_ALIVE;
    } else {
      process.env.SHIVA_KEEP_ALIVE = previousValue;
    }
  }
});

test("agent and expense-sheet configuration is normalized without exposing secrets", () => {
  withEnvironment(
    {
      SHIVA_TIME_ZONE: " Asia/Kolkata ",
      AGENT_MAX_STEPS: "6",
      AGENT_REQUEST_TIMEOUT_MS: "240000",
      EXPENSE_SHEET_ID: " sheet-id_123 ",
      EXPENSE_SHEET_REQUEST_TIMEOUT_MS: "9000",
      GOOGLE_OAUTH_CLIENT_ID: " oauth-client ",
      GOOGLE_OAUTH_CLIENT_SECRET: " oauth-secret ",
      GOOGLE_OAUTH_REFRESH_TOKEN: " oauth-refresh ",
      BRAVE_SEARCH_API_KEY: " secret-token ",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.timeZone, "Asia/Kolkata");
      assert.equal(config.agentMaxSteps, 6);
      assert.equal(config.agentRequestTimeoutMs, 240_000);
      assert.equal(config.expenseSheetId, "sheet-id_123");
      assert.equal(config.expenseSheetRequestTimeoutMs, 9_000);
      assert.deepEqual(config.googleUserOAuth, {
        clientId: "oauth-client",
        clientSecret: "oauth-secret",
        refreshToken: "oauth-refresh",
      });
      assert.equal(config.braveSearchApiKey, "secret-token");
    },
  );
});

test("invalid agent configuration fails at startup", () => {
  withEnvironment({
    SHIVA_TIME_ZONE: "Mars/Olympus",
    AGENT_MAX_STEPS: "0",
    AGENT_REQUEST_TIMEOUT_MS: "999",
    EXPENSE_SHEET_ID: "https://docs.google.com/spreadsheets/d/not-an-id",
    GOOGLE_OAUTH_CLIENT_ID: "incomplete-oauth-client",
    BRAVE_SEARCH_URL: "https://example.com",
  }, () => {
    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /SHIVA_TIME_ZONE/.test(error.message) &&
        /AGENT_MAX_STEPS/.test(error.message) &&
        /AGENT_REQUEST_TIMEOUT_MS/.test(error.message) &&
        /EXPENSE_SHEET_ID/.test(error.message) &&
        /GOOGLE_OAUTH_CLIENT_SECRET/.test(error.message) &&
        /GOOGLE_OAUTH_REFRESH_TOKEN/.test(error.message) &&
        /BRAVE_SEARCH_URL/.test(error.message) &&
        !/Olympus/.test(error.message),
    );
  });
});

function withEnvironment(
  values: Readonly<Record<string, string>>,
  run: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

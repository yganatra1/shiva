import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConfigurationError,
  loadConfig,
  loadDeviceAgentConfig,
  loadGoogleAgentConfig,
} from "../src/config/environment.js";

test("numeric SHIVA_KEEP_ALIVE values are normalized for the Ollama API", () => {
  const previousKeepAlive = process.env.SHIVA_KEEP_ALIVE;
  const previousApiKey = process.env.GEMINI_API_KEY;

  try {
    process.env.GEMINI_API_KEY = "test-gemini-api-key";

    process.env.SHIVA_KEEP_ALIVE = "-1";
    assert.equal(loadConfig().keepAlive, -1);

    process.env.SHIVA_KEEP_ALIVE = "0";
    assert.equal(loadConfig().keepAlive, 0);

    process.env.SHIVA_KEEP_ALIVE = "3600";
    assert.equal(loadConfig().keepAlive, 3600);

    process.env.SHIVA_KEEP_ALIVE = "30m";
    assert.equal(loadConfig().keepAlive, "30m");
  } finally {
    if (previousKeepAlive === undefined) {
      delete process.env.SHIVA_KEEP_ALIVE;
    } else {
      process.env.SHIVA_KEEP_ALIVE = previousKeepAlive;
    }
    if (previousApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = previousApiKey;
    }
  }
});

test("SHIVA_BRAIN_PROVIDER selects the chat brain and gates GEMINI_API_KEY accordingly", () => {
  withEnvironment({ GEMINI_API_KEY: "" }, () => {
    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /GEMINI_API_KEY/.test(error.message),
    );
  });

  withEnvironment(
    { SHIVA_BRAIN_PROVIDER: "ollama", GEMINI_API_KEY: "" },
    () => {
      const config = loadConfig();
      assert.equal(config.brainProvider, "ollama");
      assert.equal(config.geminiApiKey, undefined);
    },
  );

  withEnvironment({ GEMINI_API_KEY: "real-key" }, () => {
    const config = loadConfig();
    assert.equal(config.brainProvider, "gemini");
    assert.equal(config.geminiApiKey, "real-key");
  });

  withEnvironment({ SHIVA_BRAIN_PROVIDER: "not-a-provider" }, () => {
    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /SHIVA_BRAIN_PROVIDER/.test(error.message),
    );
  });
});

test("an Ollama-tag SHIVA_MODEL is rejected up front when SHIVA_BRAIN_PROVIDER=gemini", () => {
  withEnvironment(
    { SHIVA_MODEL: "gemma4:26b-a4b-it-q4_K_M" },
    () => {
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigurationError &&
          /SHIVA_MODEL/.test(error.message) &&
          /Ollama tag/.test(error.message),
      );
    },
  );

  // The same value is fine once brainProvider is actually ollama.
  withEnvironment(
    {
      SHIVA_BRAIN_PROVIDER: "ollama",
      GEMINI_API_KEY: "",
      SHIVA_MODEL: "gemma4:26b-a4b-it-q4_K_M",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.model, "gemma4:26b-a4b-it-q4_K_M");
    },
  );
});

test("Core normalizes orchestration config and discards inherited Google secrets", () => {
  withEnvironment(
    {
      SHIVA_TIME_ZONE: " Asia/Kolkata ",
      AGENT_MAX_STEPS: "6",
      AGENT_REQUEST_TIMEOUT_MS: "240000",
      REDIS_URL: " redis://127.0.0.1:6380 ",
      AGENT_TASK_TIMEOUT_MS: "180000",
      AGENT_RECLAIM_IDLE_MS: "45000",
      AGENT_MAX_DELIVERY_ATTEMPTS: "4",
      AGENT_HEARTBEAT_TTL_SECONDS: "21",
      SHIVA_MAX_EXECUTION_MODE: " AUTO ",
      SHIVA_CONFIRMATION_TTL_MS: "420000",
      EXPENSE_SHEET_ID: " sheet-id_123 ",
      EXPENSE_SHEET_REQUEST_TIMEOUT_MS: "9000",
      GOOGLE_OAUTH_CLIENT_ID: " oauth-client ",
      GOOGLE_OAUTH_CLIENT_SECRET: " oauth-secret ",
      GOOGLE_OAUTH_REFRESH_TOKEN: " oauth-refresh ",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/google-key.json",
      BRAVE_SEARCH_API_KEY: " secret-token ",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.timeZone, "Asia/Kolkata");
      assert.equal(config.agentMaxSteps, 6);
      assert.equal(config.agentRequestTimeoutMs, 240_000);
      assert.equal(config.redisUrl, "redis://127.0.0.1:6380");
      assert.equal(config.agentTaskTimeoutMs, 180_000);
      assert.equal(config.agentReclaimIdleMs, 45_000);
      assert.equal(config.agentMaxDeliveryAttempts, 4);
      assert.equal(config.agentHeartbeatTtlSeconds, 21);
      assert.equal(config.maxExecutionMode, "AUTO");
      assert.equal(config.confirmationTtlMs, 420_000);
      assert.equal(config.expenseSheetId, "sheet-id_123");
      assert.equal(config.expenseSheetRequestTimeoutMs, 9_000);
      assert.equal("googleUserOAuth" in config, false);
      assert.equal(config.googleUserOAuth, undefined);
      assert.equal(process.env.GOOGLE_OAUTH_CLIENT_ID, undefined);
      assert.equal(process.env.GOOGLE_OAUTH_CLIENT_SECRET, undefined);
      assert.equal(process.env.GOOGLE_OAUTH_REFRESH_TOKEN, undefined);
      assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.equal(config.braveSearchApiKey, "secret-token");
    },
  );
});

test("invalid agent configuration fails at startup", () => {
  withEnvironment({
    SHIVA_TIME_ZONE: "Mars/Olympus",
    AGENT_MAX_STEPS: "0",
    AGENT_REQUEST_TIMEOUT_MS: "999",
    REDIS_URL: "https://example.com/queue",
    AGENT_TASK_TIMEOUT_MS: "4999",
    AGENT_RECLAIM_IDLE_MS: "999",
    AGENT_MAX_DELIVERY_ATTEMPTS: "0",
    AGENT_HEARTBEAT_TTL_SECONDS: "2",
    EXPENSE_SHEET_ID: "https://docs.google.com/spreadsheets/d/not-an-id",
    GOOGLE_OAUTH_CLIENT_ID: "incomplete-oauth-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    GOOGLE_OAUTH_REFRESH_TOKEN: "",
    BRAVE_SEARCH_URL: "https://example.com",
  }, () => {
    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /SHIVA_TIME_ZONE/.test(error.message) &&
        /AGENT_MAX_STEPS/.test(error.message) &&
        /AGENT_REQUEST_TIMEOUT_MS/.test(error.message) &&
        /REDIS_URL/.test(error.message) &&
        /AGENT_TASK_TIMEOUT_MS/.test(error.message) &&
        /AGENT_RECLAIM_IDLE_MS/.test(error.message) &&
        /AGENT_MAX_DELIVERY_ATTEMPTS/.test(error.message) &&
        /AGENT_HEARTBEAT_TTL_SECONDS/.test(error.message) &&
        /EXPENSE_SHEET_ID/.test(error.message) &&
        !/GOOGLE_OAUTH/.test(error.message) &&
        /BRAVE_SEARCH_URL/.test(error.message) &&
        !/Olympus/.test(error.message),
    );
  });
});

test("invalid execution configuration fails at startup", () => {
  withEnvironment(
    {
      SHIVA_MAX_EXECUTION_MODE: "UNRESTRICTED",
      SHIVA_CONFIRMATION_TTL_MS: "3600001",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigurationError &&
          /SHIVA_MAX_EXECUTION_MODE/.test(error.message) &&
          /SHIVA_CONFIRMATION_TTL_MS/.test(error.message) &&
          !/UNRESTRICTED/.test(error.message),
      );
    },
  );
});

test("face service and recognition thresholds are normalized and bounded", () => {
  withEnvironment(
    {
      FACE_SERVICE_URL: "http://127.0.0.1:8103",
      FACE_REQUEST_TIMEOUT_MS: "45000",
      FACE_MATCH_THRESHOLD: "0.61",
      FACE_ENROLLMENT_THRESHOLD: "0.42",
      FACE_AMBIGUITY_MARGIN: "0.06",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.faceServiceUrl, "http://127.0.0.1:8103");
      assert.equal(config.faceRequestTimeoutMs, 45_000);
      assert.equal(config.faceMatchThreshold, 0.61);
      assert.equal(config.faceEnrollmentThreshold, 0.42);
      assert.equal(config.faceAmbiguityMargin, 0.06);
    },
  );

  withEnvironment(
    {
      FACE_SERVICE_URL: "file:///tmp/model",
      FACE_MATCH_THRESHOLD: "1",
      FACE_ENROLLMENT_THRESHOLD: "0",
      FACE_AMBIGUITY_MARGIN: "0.5",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        (error: unknown) =>
          error instanceof ConfigurationError &&
          /FACE_SERVICE_URL/.test(error.message) &&
          /FACE_MATCH_THRESHOLD/.test(error.message) &&
          /FACE_ENROLLMENT_THRESHOLD/.test(error.message) &&
          /FACE_AMBIGUITY_MARGIN/.test(error.message) &&
          !/\/tmp\/model/.test(error.message),
      );
    },
  );
});

test("device-agent loads only its declared config and scrubs inherited Shiva secrets", () => {
  withEnvironment(
    {
      REDIS_URL: "redis://127.0.0.1:6381",
      DEVICE_WS_TOKEN: "device-token",
      DEVICE_AGENT_MOCK_CALL_OUTCOME: "not_answered",
      DATABASE_URL: "postgresql://user:database-secret@127.0.0.1/shiva",
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/google-key.json",
      BRAVE_SEARCH_API_KEY: "web-secret",
      STRIPE_API_KEY: "stripe-secret",
      GITHUB_TOKEN: "github-secret",
      UNRELATED_API_TOKEN: "unrelated-secret",
    },
    () => {
      const config = loadDeviceAgentConfig();
      assert.equal(config.redisUrl, "redis://127.0.0.1:6381");
      assert.equal(config.deviceWsToken, "device-token");
      assert.equal(config.deviceAgentMockCallOutcome, "not_answered");
      assert.equal("databaseUrl" in config, false);
      assert.equal("googleUserOAuth" in config, false);
      assert.equal("braveSearchApiKey" in config, false);
      assert.equal(process.env.DATABASE_URL, undefined);
      assert.equal(process.env.GOOGLE_OAUTH_CLIENT_SECRET, undefined);
      assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.equal(process.env.BRAVE_SEARCH_API_KEY, undefined);
      assert.equal(process.env.STRIPE_API_KEY, undefined);
      assert.equal(process.env.GITHUB_TOKEN, undefined);
      assert.equal(process.env.UNRELATED_API_TOKEN, undefined);
      assert.equal(process.env.DEVICE_WS_TOKEN, "device-token");
    },
  );
});

test("google-agent keeps Google credentials but no Core database, device, or web secrets", () => {
  withEnvironment(
    {
      REDIS_URL: "redis://127.0.0.1:6382",
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/google-key.json",
      DATABASE_URL: "postgresql://user:database-secret@127.0.0.1/shiva",
      DEVICE_WS_TOKEN: "device-secret",
      BRAVE_SEARCH_API_KEY: "web-secret",
      STRIPE_API_KEY: "stripe-secret",
      GITHUB_TOKEN: "github-secret",
      UNRELATED_API_TOKEN: "unrelated-secret",
    },
    () => {
      const config = loadGoogleAgentConfig();
      assert.equal(config.redisUrl, "redis://127.0.0.1:6382");
      assert.deepEqual(config.googleUserOAuth, {
        clientId: "google-client",
        clientSecret: "google-secret",
        refreshToken: "google-refresh",
      });
      assert.equal("databaseUrl" in config, false);
      assert.equal("deviceWsToken" in config, false);
      assert.equal("braveSearchApiKey" in config, false);
      assert.equal(process.env.DATABASE_URL, undefined);
      assert.equal(process.env.DEVICE_WS_TOKEN, undefined);
      assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.equal(process.env.BRAVE_SEARCH_API_KEY, undefined);
      assert.equal(process.env.STRIPE_API_KEY, undefined);
      assert.equal(process.env.GITHUB_TOKEN, undefined);
      assert.equal(process.env.UNRELATED_API_TOKEN, undefined);
      assert.equal(process.env.GOOGLE_OAUTH_CLIENT_SECRET, "google-secret");
    },
  );
});

test("partial Google OAuth configuration is rejected only by google-agent", () => {
  withEnvironment(
    {
      GOOGLE_OAUTH_CLIENT_ID: "incomplete-oauth-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
      GOOGLE_OAUTH_REFRESH_TOKEN: "",
    },
    () => {
      assert.throws(
        () => loadGoogleAgentConfig(),
        (error: unknown) =>
          error instanceof ConfigurationError &&
          /GOOGLE_OAUTH_CLIENT_SECRET/.test(error.message) &&
          /GOOGLE_OAUTH_REFRESH_TOKEN/.test(error.message) &&
          !/incomplete-oauth-client/.test(error.message),
      );
    },
  );
});

test("device call mock mode is explicit and validates its bounded outcomes", () => {
  withEnvironment({ DEVICE_AGENT_MOCK_CALL_OUTCOME: "busy" }, () => {
    assert.throws(
      () => loadDeviceAgentConfig(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /DEVICE_AGENT_MOCK_CALL_OUTCOME/.test(error.message) &&
        !/busy/.test(error.message),
    );
  });
});

test("production device-agent never invokes a dotenv reader", () => {
  withEnvironment(
    {
      NODE_ENV: "production",
      SHIVA_LOAD_AGENT_ENV_FILES: "true",
      REDIS_URL: "redis://127.0.0.1:6383",
      GOOGLE_OAUTH_CLIENT_SECRET: "must-be-scrubbed",
    },
    () => {
      let reads = 0;
      const config = loadDeviceAgentConfig({
        readEnvironmentFile() {
          reads += 1;
          throw new Error("production must not read any environment file");
        },
      });

      assert.equal(reads, 0);
      assert.equal(config.redisUrl, "redis://127.0.0.1:6383");
      assert.equal(process.env.GOOGLE_OAUTH_CLIENT_SECRET, undefined);
    },
  );
});

test("production google-agent never invokes a dotenv reader", () => {
  withEnvironment(
    {
      NODE_ENV: "production",
      SHIVA_LOAD_AGENT_ENV_FILES: "true",
      REDIS_URL: "redis://127.0.0.1:6384",
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh",
      DEVICE_WS_TOKEN: "must-be-scrubbed",
    },
    () => {
      let reads = 0;
      const config = loadGoogleAgentConfig({
        readEnvironmentFile() {
          reads += 1;
          throw new Error("production must not read any environment file");
        },
      });

      assert.equal(reads, 0);
      assert.equal(config.redisUrl, "redis://127.0.0.1:6384");
      assert.equal(config.googleUserOAuth?.clientSecret, "google-secret");
      assert.equal(process.env.DEVICE_WS_TOKEN, undefined);
    },
  );
});

test("development workers read only their fixed agent-specific environment files", () => {
  withEnvironment(
    { NODE_ENV: "development", SHIVA_LOAD_AGENT_ENV_FILES: "true" },
    () => {
      let devicePath = "";
      const device = loadDeviceAgentConfig({
        readEnvironmentFile(path) {
          devicePath = path;
          return {
            REDIS_URL: "redis://127.0.0.1:6385",
            GOOGLE_OAUTH_CLIENT_SECRET: "wrong-file-secret",
          };
        },
      });
      assert.match(devicePath, /\.env\.device-agent$/);
      assert.equal(device.redisUrl, "redis://127.0.0.1:6385");
      assert.equal("googleUserOAuth" in device, false);
    },
  );

  withEnvironment(
    { NODE_ENV: "development", SHIVA_LOAD_AGENT_ENV_FILES: "true" },
    () => {
      let googlePath = "";
      const google = loadGoogleAgentConfig({
        readEnvironmentFile(path) {
          googlePath = path;
          return {
            REDIS_URL: "redis://127.0.0.1:6386",
            GOOGLE_OAUTH_CLIENT_ID: "google-client",
            GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
            GOOGLE_OAUTH_REFRESH_TOKEN: "google-refresh",
            DEVICE_WS_TOKEN: "wrong-file-secret",
          };
        },
      });
      assert.match(googlePath, /\.env\.google-agent$/);
      assert.equal(google.redisUrl, "redis://127.0.0.1:6386");
      assert.equal(google.googleUserOAuth?.clientSecret, "google-secret");
      assert.equal("deviceWsToken" in google, false);
    },
  );
});

test("dotenv loading is opt-in even outside production", () => {
  withEnvironment({ NODE_ENV: "development" }, () => {
    let reads = 0;
    loadDeviceAgentConfig({
      readEnvironmentFile() {
        reads += 1;
        return { REDIS_URL: "redis://127.0.0.1:6399" };
      },
    });
    assert.equal(reads, 0);
  });
});

function withEnvironment(
  values: Readonly<Record<string, string>>,
  run: () => void,
): void {
  const previous = { ...process.env };
  process.env.GEMINI_API_KEY = "test-gemini-api-key";
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

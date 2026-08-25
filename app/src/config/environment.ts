import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  executionModeSchema,
  type ExecutionMode,
} from "../security/execution-mode";

const rootEnvironmentPath = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);
const deviceAgentEnvironmentPath = fileURLToPath(
  new URL("../../../.env.device-agent", import.meta.url),
);
const googleAgentEnvironmentPath = fileURLToPath(
  new URL("../../../.env.google-agent", import.meta.url),
);

const httpBaseUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "must use the http or https protocol",
      });
    }

    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "must not contain credentials, a query, or a fragment",
      });
    }

    if (url.pathname !== "/") {
      context.addIssue({
        code: "custom",
        message: "must not contain a path",
      });
    }
  });

const postgresqlUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }

    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      context.addIssue({
        code: "custom",
        message: "must use the postgres or postgresql protocol",
      });
    }
  });
const redisUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const protocol = new URL(value).protocol;
    if (protocol !== "redis:" && protocol !== "rediss:") {
      context.addIssue({
        code: "custom",
        message: "must use the redis or rediss protocol",
      });
    }
  });
const httpsBaseUrlSchema = httpBaseUrlSchema.superRefine((value, context) => {
  if (new URL(value).protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "must use the https protocol",
    });
  }
});
const braveSearchUrlSchema = httpsBaseUrlSchema.refine(
  (value) => new URL(value).hostname === "api.search.brave.com",
  { message: "must use the official api.search.brave.com host" },
);

const booleanEnvironmentSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const optionalSecretSchema = z
  .string()
  .transform((value): string | undefined => value.trim() || undefined)
  .optional();
const optionalSheetIdSchema = optionalSecretSchema.refine(
  (value) => value === undefined || /^[A-Za-z0-9_-]{5,256}$/.test(value),
  { message: "must be a Google spreadsheet ID, not a full URL" },
);
const optionalDeviceMockCallOutcomeSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim();
    return normalized || undefined;
  },
  z.enum(["answered", "not_answered"]).optional(),
);
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isValidTimeZone, { message: "must be a valid IANA time zone" });

const numericEnvironmentValue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ollamaKeepAliveSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value): string | number =>
    numericEnvironmentValue.test(value) ? Number(value) : value,
  );

const environmentSchema = z
  .object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  SHIVA_BRAIN_PROVIDER: z.enum(["ollama", "gemini"]).default("gemini"),
  OLLAMA_URL: httpBaseUrlSchema.default("http://127.0.0.1:11434"),
  SHIVA_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default("gemma-4-26b-a4b-it"),
  GEMINI_API_KEY: optionalSecretSchema,
  SHIVA_CONTEXT_LENGTH: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(16_384),
  SHIVA_KEEP_ALIVE: ollamaKeepAliveSchema.default("30m"),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_800_000)
    .default(300_000),
  DATABASE_URL: postgresqlUrlSchema.default(
    "postgresql://shiva:change-me@127.0.0.1:5432/shiva",
  ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: booleanEnvironmentSchema.default(false),
  REDIS_URL: redisUrlSchema.default("redis://127.0.0.1:6379"),
  SHIVA_USER_ID: z
    .string()
    .uuid()
    .default("00000000-0000-4000-8000-000000000001"),
  SHIVA_USER_NAME: z.string().trim().min(1).max(255).default("Yash"),
  SHIVA_TIME_ZONE: timeZoneSchema.default("Asia/Kolkata"),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(32).default(12),
  AGENT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_800_000)
    .default(300_000),
  AGENT_TASK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(1_800_000)
    .default(300_000),
  AGENT_RECLAIM_IDLE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(30_000),
  AGENT_MAX_DELIVERY_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3),
  AGENT_HEARTBEAT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3)
    .max(300)
    .default(15),
  SHIVA_MAX_EXECUTION_MODE: z
    .string()
    .trim()
    .pipe(executionModeSchema)
    .default("FULL_ACCESS"),
  SHIVA_CONFIRMATION_TTL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  EXPENSE_SHEET_ID: optionalSheetIdSchema,
  EXPENSE_SHEET_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
  DEVICE_AGENT_URL: httpBaseUrlSchema.default("http://127.0.0.1:3002"),
  DEVICE_AGENT_HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  DEVICE_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  DEVICE_AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(32).default(15),
  DEVICE_WS_TOKEN: optionalSecretSchema,
  DEVICE_AGENT_MOCK_CALL_OUTCOME: optionalDeviceMockCallOutcomeSchema,
  GOOGLE_OAUTH_CLIENT_ID: optionalSecretSchema,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalSecretSchema,
  GOOGLE_OAUTH_REFRESH_TOKEN: optionalSecretSchema,
  BRAVE_SEARCH_API_KEY: optionalSecretSchema,
  BRAVE_SEARCH_URL: braveSearchUrlSchema.default("https://api.search.brave.com"),
  WEB_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
  WEB_MAX_CONTENT_BYTES: z.coerce
    .number()
    .int()
    .min(16_384)
    .max(2_097_152)
    .default(524_288),
  EMBEDDING_MODEL: z.string().trim().min(1).max(255).default("embeddinggemma"),
  EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(60_000),
  WORKING_MEMORY_MESSAGE_LIMIT: z.coerce
    .number()
    .int()
    .min(2)
    .max(200)
    .default(20),
  MEMORY_RETRIEVAL_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8),
  ASR_SERVICE_URL: httpBaseUrlSchema.default("http://127.0.0.1:8101"),
  TTS_SERVICE_URL: httpBaseUrlSchema.default("http://127.0.0.1:8102"),
  FACE_SERVICE_URL: httpBaseUrlSchema.default("http://127.0.0.1:8103"),
  ASR_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default("Qwen/Qwen3-ASR-0.6B"),
  TTS_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
  TTS_SPEAKER: z.string().trim().min(1).max(64).default("Aiden"),
  ASR_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000),
  TTS_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000),
  FACE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000),
  FACE_MATCH_THRESHOLD: z.coerce.number().min(0.1).max(0.95).default(0.5),
  FACE_ENROLLMENT_THRESHOLD: z.coerce
    .number()
    .min(0.1)
    .max(0.95)
    .default(0.35),
  FACE_AMBIGUITY_MARGIN: z.coerce.number().min(0).max(0.25).default(0.03),
  SHIVA_PERF_LOG: booleanEnvironmentSchema.default(false),
  SHIVA_AGENT_TRACE_LOG: booleanEnvironmentSchema.default(true),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  })
  .superRefine((environment, context) => {
    if (environment.SHIVA_BRAIN_PROVIDER === "gemini" && !environment.GEMINI_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["GEMINI_API_KEY"],
        message: "is required when SHIVA_BRAIN_PROVIDER=gemini",
      });
    }

    const oauth = [
      environment.GOOGLE_OAUTH_CLIENT_ID,
      environment.GOOGLE_OAUTH_CLIENT_SECRET,
      environment.GOOGLE_OAUTH_REFRESH_TOKEN,
    ];
    if (oauth.some(Boolean) && !oauth.every(Boolean)) {
      for (const key of [
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN",
      ] as const) {
        if (!environment[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "is required when Google user OAuth is configured",
          });
        }
      }
    }
  });

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly brainProvider: "ollama" | "gemini";
  readonly ollamaUrl: string;
  readonly model: string;
  readonly geminiApiKey?: string;
  readonly contextLength: number;
  readonly keepAlive: string | number;
  readonly ollamaRequestTimeoutMs: number;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseSsl: boolean;
  readonly redisUrl: string;
  readonly userId: string;
  readonly userName: string;
  readonly timeZone: string;
  readonly agentMaxSteps: number;
  readonly agentRequestTimeoutMs: number;
  readonly agentTaskTimeoutMs: number;
  readonly agentReclaimIdleMs: number;
  readonly agentMaxDeliveryAttempts: number;
  readonly agentHeartbeatTtlSeconds: number;
  readonly maxExecutionMode: ExecutionMode;
  readonly confirmationTtlMs: number;
  readonly expenseSheetId?: string;
  readonly expenseSheetRequestTimeoutMs: number;
  /** Where the device agent listens; shiva-api never holds the phone's WebSocket itself. */
  readonly deviceAgentUrl: string;
  /** Bind address/port for the device-agent process itself (app/src/agents/device). */
  readonly deviceAgentHost: string;
  readonly deviceAgentPort: number;
  /** Bounds the device-agent's own tool-calling loop for one delegated goal. */
  readonly deviceAgentMaxSteps: number;
  /** Required Android companion app connection token; unset means no auth is enforced. */
  readonly deviceWsToken?: string;
  /** Explicit development/POC simulation; unset always uses the real bridge. */
  readonly deviceAgentMockCallOutcome?: "answered" | "not_answered";
  readonly googleUserOAuth?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  };
  readonly braveSearchApiKey?: string;
  readonly braveSearchUrl: string;
  readonly webRequestTimeoutMs: number;
  readonly webMaxContentBytes: number;
  readonly embeddingModel: string;
  readonly embeddingRequestTimeoutMs: number;
  readonly workingMemoryMessageLimit: number;
  readonly memoryRetrievalLimit: number;
  readonly asrServiceUrl: string;
  readonly ttsServiceUrl: string;
  readonly faceServiceUrl: string;
  readonly asrModel: string;
  readonly ttsModel: string;
  readonly ttsSpeaker: string;
  readonly asrRequestTimeoutMs: number;
  readonly ttsRequestTimeoutMs: number;
  readonly faceRequestTimeoutMs: number;
  readonly faceMatchThreshold: number;
  readonly faceEnrollmentThreshold: number;
  readonly faceAmbiguityMargin: number;
  readonly performanceLogging: boolean;
  /** Full per-step planner prompt/response/decision tracing — verbose, opt-in. */
  readonly agentTraceLog: boolean;
  readonly nodeEnv: "development" | "test" | "production";
}

/**
 * The device process deliberately receives only the values needed for Redis,
 * Ollama, and its Android bridge. Keeping this as a real narrow type prevents
 * a future device feature from casually reaching for a Core/Google secret.
 */
export type DeviceAgentConfig = Pick<
  AppConfig,
  | "brainProvider"
  | "ollamaUrl"
  | "model"
  | "geminiApiKey"
  | "contextLength"
  | "keepAlive"
  | "ollamaRequestTimeoutMs"
  | "redisUrl"
  | "agentReclaimIdleMs"
  | "agentMaxDeliveryAttempts"
  | "agentHeartbeatTtlSeconds"
  | "deviceAgentHost"
  | "deviceAgentPort"
  | "deviceAgentMaxSteps"
  | "deviceWsToken"
  | "deviceAgentMockCallOutcome"
  | "nodeEnv"
>;

/** Google workers need no Core database, device bridge, web, or voice config. */
export type GoogleAgentConfig = Pick<
  AppConfig,
  | "brainProvider"
  | "ollamaUrl"
  | "model"
  | "geminiApiKey"
  | "contextLength"
  | "keepAlive"
  | "ollamaRequestTimeoutMs"
  | "redisUrl"
  | "userId"
  | "userName"
  | "timeZone"
  | "agentMaxSteps"
  | "agentRequestTimeoutMs"
  | "agentReclaimIdleMs"
  | "agentMaxDeliveryAttempts"
  | "agentHeartbeatTtlSeconds"
  | "expenseSheetRequestTimeoutMs"
  | "googleUserOAuth"
  | "nodeEnv"
>;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/** @internal Dependency seam used to prove production never opens dotenv. */
export interface AgentEnvironmentLoadOptions {
  readonly readEnvironmentFile?: (
    path: string,
  ) => Readonly<Record<string, string>>;
}

export function loadConfig(): AppConfig {
  dotenv.config({ path: rootEnvironmentPath, quiet: true });
  // Core coordinates Google work but does not execute it. Do not retain
  // provider credentials even if a legacy/shared environment supplied them;
  // the independently configured google-agent is their only consumer.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GOOGLE_")) delete process.env[key];
  }
  return parseConfig(process.env);
}

const DEVICE_AGENT_ENVIRONMENT_KEYS = [
  "SHIVA_BRAIN_PROVIDER",
  "OLLAMA_URL",
  "SHIVA_MODEL",
  "GEMINI_API_KEY",
  "SHIVA_CONTEXT_LENGTH",
  "SHIVA_KEEP_ALIVE",
  "OLLAMA_REQUEST_TIMEOUT_MS",
  "REDIS_URL",
  "AGENT_RECLAIM_IDLE_MS",
  "AGENT_MAX_DELIVERY_ATTEMPTS",
  "AGENT_HEARTBEAT_TTL_SECONDS",
  "DEVICE_AGENT_HOST",
  "DEVICE_AGENT_PORT",
  "DEVICE_AGENT_MAX_STEPS",
  "DEVICE_WS_TOKEN",
  "DEVICE_AGENT_MOCK_CALL_OUTCOME",
  "NODE_ENV",
] as const;

const GOOGLE_AGENT_ENVIRONMENT_KEYS = [
  "SHIVA_BRAIN_PROVIDER",
  "OLLAMA_URL",
  "SHIVA_MODEL",
  "GEMINI_API_KEY",
  "SHIVA_CONTEXT_LENGTH",
  "SHIVA_KEEP_ALIVE",
  "OLLAMA_REQUEST_TIMEOUT_MS",
  "REDIS_URL",
  "SHIVA_USER_ID",
  "SHIVA_USER_NAME",
  "SHIVA_TIME_ZONE",
  "AGENT_MAX_STEPS",
  "AGENT_REQUEST_TIMEOUT_MS",
  "AGENT_RECLAIM_IDLE_MS",
  "AGENT_MAX_DELIVERY_ATTEMPTS",
  "AGENT_HEARTBEAT_TTL_SECONDS",
  "EXPENSE_SHEET_REQUEST_TIMEOUT_MS",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "NODE_ENV",
] as const;

/** Non-secret host settings that Node/network libraries may still require. */
const SAFE_AGENT_RUNTIME_ENVIRONMENT_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * Loads a least-privilege config for the independently managed device worker.
 * Production reads only inherited/PM2/Compose values. Local development may
 * read the fixed, agent-specific .env.device-agent file; it never opens .env.
 */
export function loadDeviceAgentConfig(
  options: AgentEnvironmentLoadOptions = {},
): DeviceAgentConfig {
  const config = loadScopedAgentConfig(
    DEVICE_AGENT_ENVIRONMENT_KEYS,
    deviceAgentEnvironmentPath,
    options,
  );
  return {
    brainProvider: config.brainProvider,
    ollamaUrl: config.ollamaUrl,
    model: config.model,
    ...(config.geminiApiKey ? { geminiApiKey: config.geminiApiKey } : {}),
    contextLength: config.contextLength,
    keepAlive: config.keepAlive,
    ollamaRequestTimeoutMs: config.ollamaRequestTimeoutMs,
    redisUrl: config.redisUrl,
    agentReclaimIdleMs: config.agentReclaimIdleMs,
    agentMaxDeliveryAttempts: config.agentMaxDeliveryAttempts,
    agentHeartbeatTtlSeconds: config.agentHeartbeatTtlSeconds,
    deviceAgentHost: config.deviceAgentHost,
    deviceAgentPort: config.deviceAgentPort,
    deviceAgentMaxSteps: config.deviceAgentMaxSteps,
    ...(config.deviceWsToken ? { deviceWsToken: config.deviceWsToken } : {}),
    ...(config.deviceAgentMockCallOutcome
      ? { deviceAgentMockCallOutcome: config.deviceAgentMockCallOutcome }
      : {}),
    nodeEnv: config.nodeEnv,
  };
}

/** Loads only Redis/Ollama/Google values; it never opens Core's root .env. */
export function loadGoogleAgentConfig(
  options: AgentEnvironmentLoadOptions = {},
): GoogleAgentConfig {
  const config = loadScopedAgentConfig(
    GOOGLE_AGENT_ENVIRONMENT_KEYS,
    googleAgentEnvironmentPath,
    options,
  );
  return {
    brainProvider: config.brainProvider,
    ollamaUrl: config.ollamaUrl,
    model: config.model,
    ...(config.geminiApiKey ? { geminiApiKey: config.geminiApiKey } : {}),
    contextLength: config.contextLength,
    keepAlive: config.keepAlive,
    ollamaRequestTimeoutMs: config.ollamaRequestTimeoutMs,
    redisUrl: config.redisUrl,
    userId: config.userId,
    userName: config.userName,
    timeZone: config.timeZone,
    agentMaxSteps: config.agentMaxSteps,
    agentRequestTimeoutMs: config.agentRequestTimeoutMs,
    agentReclaimIdleMs: config.agentReclaimIdleMs,
    agentMaxDeliveryAttempts: config.agentMaxDeliveryAttempts,
    agentHeartbeatTtlSeconds: config.agentHeartbeatTtlSeconds,
    expenseSheetRequestTimeoutMs: config.expenseSheetRequestTimeoutMs,
    ...(config.googleUserOAuth
      ? { googleUserOAuth: config.googleUserOAuth }
      : {}),
    nodeEnv: config.nodeEnv,
  };
}

function loadScopedAgentConfig(
  allowedKeys: readonly string[],
  developmentEnvironmentPath: string,
  options: AgentEnvironmentLoadOptions,
): AppConfig {
  // Production workers receive an explicit environment from PM2 or Compose
  // and never perform any dotenv file read. Development must explicitly opt
  // in, and then gets a fixed per-agent file rather than Core's root .env.
  // Explicit shell values retain precedence.
  const loadDevelopmentFile =
    process.env.NODE_ENV !== "production" &&
    process.env.SHIVA_LOAD_AGENT_ENV_FILES === "true";
  const fileEnvironment =
    loadDevelopmentFile
      ? {
          ...(options.readEnvironmentFile ?? readAgentEnvironmentFile)(
            developmentEnvironmentPath,
          ),
        }
      : {};
  const fileEnvironmentKeys = Object.keys(fileEnvironment);
  const allowed = new Set([
    ...allowedKeys,
    ...SAFE_AGENT_RUNTIME_ENVIRONMENT_KEYS,
  ]);
  const scopedEnvironment: Record<string, string> = {};
  for (const key of allowed) {
    const inherited = process.env[key];
    const fromFile = fileEnvironment[key];
    if (inherited !== undefined) scopedEnvironment[key] = inherited;
    else if (fromFile !== undefined) scopedEnvironment[key] = fromFile;
  }
  for (const key of fileEnvironmentKeys) {
    if (!allowed.has(key)) delete fileEnvironment[key];
  }

  // PM2/npm may inherit arbitrary deployment-shell credentials. Retain only
  // this agent's declared config plus a small non-secret OS/network baseline;
  // a denylist cannot anticipate future *_TOKEN or provider-specific names.
  for (const key of Object.keys(process.env)) {
    if (!allowed.has(key)) delete process.env[key];
  }

  return parseConfig(scopedEnvironment);
}

function readAgentEnvironmentFile(path: string): Record<string, string> {
  const environment: Record<string, string> = {};
  dotenv.config({ path, quiet: true, processEnv: environment });
  return environment;
}

function parseConfig(environment: NodeJS.ProcessEnv | Record<string, string>): AppConfig {

  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");

    throw new ConfigurationError(`Invalid environment configuration: ${issues}`);
  }

  return {
    port: result.data.PORT,
    host: result.data.HOST,
    brainProvider: result.data.SHIVA_BRAIN_PROVIDER,
    ollamaUrl: result.data.OLLAMA_URL,
    model: result.data.SHIVA_MODEL,
    ...(result.data.GEMINI_API_KEY
      ? { geminiApiKey: result.data.GEMINI_API_KEY }
      : {}),
    contextLength: result.data.SHIVA_CONTEXT_LENGTH,
    keepAlive: result.data.SHIVA_KEEP_ALIVE,
    ollamaRequestTimeoutMs: result.data.OLLAMA_REQUEST_TIMEOUT_MS,
    databaseUrl: result.data.DATABASE_URL,
    databasePoolMax: result.data.DATABASE_POOL_MAX,
    databaseSsl: result.data.DATABASE_SSL,
    redisUrl: result.data.REDIS_URL,
    userId: result.data.SHIVA_USER_ID,
    userName: result.data.SHIVA_USER_NAME,
    timeZone: result.data.SHIVA_TIME_ZONE,
    agentMaxSteps: result.data.AGENT_MAX_STEPS,
    agentRequestTimeoutMs: result.data.AGENT_REQUEST_TIMEOUT_MS,
    agentTaskTimeoutMs: result.data.AGENT_TASK_TIMEOUT_MS,
    agentReclaimIdleMs: result.data.AGENT_RECLAIM_IDLE_MS,
    agentMaxDeliveryAttempts: result.data.AGENT_MAX_DELIVERY_ATTEMPTS,
    agentHeartbeatTtlSeconds: result.data.AGENT_HEARTBEAT_TTL_SECONDS,
    maxExecutionMode: result.data.SHIVA_MAX_EXECUTION_MODE,
    confirmationTtlMs: result.data.SHIVA_CONFIRMATION_TTL_MS,
    ...(result.data.EXPENSE_SHEET_ID
      ? { expenseSheetId: result.data.EXPENSE_SHEET_ID }
      : {}),
    expenseSheetRequestTimeoutMs:
      result.data.EXPENSE_SHEET_REQUEST_TIMEOUT_MS,
    deviceAgentUrl: result.data.DEVICE_AGENT_URL,
    deviceAgentHost: result.data.DEVICE_AGENT_HOST,
    deviceAgentPort: result.data.DEVICE_AGENT_PORT,
    deviceAgentMaxSteps: result.data.DEVICE_AGENT_MAX_STEPS,
    ...(result.data.DEVICE_WS_TOKEN
      ? { deviceWsToken: result.data.DEVICE_WS_TOKEN }
      : {}),
    ...(result.data.DEVICE_AGENT_MOCK_CALL_OUTCOME
      ? { deviceAgentMockCallOutcome: result.data.DEVICE_AGENT_MOCK_CALL_OUTCOME }
      : {}),
    ...(result.data.GOOGLE_OAUTH_CLIENT_ID &&
    result.data.GOOGLE_OAUTH_CLIENT_SECRET &&
    result.data.GOOGLE_OAUTH_REFRESH_TOKEN
      ? {
          googleUserOAuth: {
            clientId: result.data.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: result.data.GOOGLE_OAUTH_CLIENT_SECRET,
            refreshToken: result.data.GOOGLE_OAUTH_REFRESH_TOKEN,
          },
        }
      : {}),
    ...(result.data.BRAVE_SEARCH_API_KEY
      ? { braveSearchApiKey: result.data.BRAVE_SEARCH_API_KEY }
      : {}),
    braveSearchUrl: result.data.BRAVE_SEARCH_URL,
    webRequestTimeoutMs: result.data.WEB_REQUEST_TIMEOUT_MS,
    webMaxContentBytes: result.data.WEB_MAX_CONTENT_BYTES,
    embeddingModel: result.data.EMBEDDING_MODEL,
    embeddingRequestTimeoutMs: result.data.EMBEDDING_REQUEST_TIMEOUT_MS,
    workingMemoryMessageLimit: result.data.WORKING_MEMORY_MESSAGE_LIMIT,
    memoryRetrievalLimit: result.data.MEMORY_RETRIEVAL_LIMIT,
    asrServiceUrl: result.data.ASR_SERVICE_URL,
    ttsServiceUrl: result.data.TTS_SERVICE_URL,
    faceServiceUrl: result.data.FACE_SERVICE_URL,
    asrModel: result.data.ASR_MODEL,
    ttsModel: result.data.TTS_MODEL,
    ttsSpeaker: result.data.TTS_SPEAKER,
    asrRequestTimeoutMs: result.data.ASR_REQUEST_TIMEOUT_MS,
    ttsRequestTimeoutMs: result.data.TTS_REQUEST_TIMEOUT_MS,
    faceRequestTimeoutMs: result.data.FACE_REQUEST_TIMEOUT_MS,
    faceMatchThreshold: result.data.FACE_MATCH_THRESHOLD,
    faceEnrollmentThreshold: result.data.FACE_ENROLLMENT_THRESHOLD,
    faceAmbiguityMargin: result.data.FACE_AMBIGUITY_MARGIN,
    performanceLogging: result.data.SHIVA_PERF_LOG,
    agentTraceLog: result.data.SHIVA_AGENT_TRACE_LOG,
    nodeEnv: result.data.NODE_ENV,
  };
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

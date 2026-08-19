import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const rootEnvironmentPath = fileURLToPath(
  new URL("../../../.env", import.meta.url),
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

const booleanEnvironmentSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const numericEnvironmentValue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ollamaKeepAliveSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value): string | number =>
    numericEnvironmentValue.test(value) ? Number(value) : value,
  );

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  OLLAMA_URL: httpBaseUrlSchema.default("http://127.0.0.1:11434"),
  SHIVA_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .default("gemma4:26b-a4b-it-q4_K_M"),
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
  SHIVA_USER_ID: z
    .string()
    .uuid()
    .default("00000000-0000-4000-8000-000000000001"),
  SHIVA_USER_NAME: z.string().trim().min(1).max(255).default("Yash"),
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
  SHIVA_PERF_LOG: booleanEnvironmentSchema.default(false),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly ollamaUrl: string;
  readonly model: string;
  readonly contextLength: number;
  readonly keepAlive: string | number;
  readonly ollamaRequestTimeoutMs: number;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseSsl: boolean;
  readonly userId: string;
  readonly userName: string;
  readonly embeddingModel: string;
  readonly embeddingRequestTimeoutMs: number;
  readonly workingMemoryMessageLimit: number;
  readonly memoryRetrievalLimit: number;
  readonly asrServiceUrl: string;
  readonly ttsServiceUrl: string;
  readonly asrModel: string;
  readonly ttsModel: string;
  readonly ttsSpeaker: string;
  readonly asrRequestTimeoutMs: number;
  readonly ttsRequestTimeoutMs: number;
  readonly performanceLogging: boolean;
  readonly nodeEnv: "development" | "test" | "production";
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export function loadConfig(): AppConfig {
  dotenv.config({ path: rootEnvironmentPath, quiet: true });

  const result = environmentSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");

    throw new ConfigurationError(`Invalid environment configuration: ${issues}`);
  }

  return {
    port: result.data.PORT,
    host: result.data.HOST,
    ollamaUrl: result.data.OLLAMA_URL,
    model: result.data.SHIVA_MODEL,
    contextLength: result.data.SHIVA_CONTEXT_LENGTH,
    keepAlive: result.data.SHIVA_KEEP_ALIVE,
    ollamaRequestTimeoutMs: result.data.OLLAMA_REQUEST_TIMEOUT_MS,
    databaseUrl: result.data.DATABASE_URL,
    databasePoolMax: result.data.DATABASE_POOL_MAX,
    databaseSsl: result.data.DATABASE_SSL,
    userId: result.data.SHIVA_USER_ID,
    userName: result.data.SHIVA_USER_NAME,
    embeddingModel: result.data.EMBEDDING_MODEL,
    embeddingRequestTimeoutMs: result.data.EMBEDDING_REQUEST_TIMEOUT_MS,
    workingMemoryMessageLimit: result.data.WORKING_MEMORY_MESSAGE_LIMIT,
    memoryRetrievalLimit: result.data.MEMORY_RETRIEVAL_LIMIT,
    asrServiceUrl: result.data.ASR_SERVICE_URL,
    ttsServiceUrl: result.data.TTS_SERVICE_URL,
    asrModel: result.data.ASR_MODEL,
    ttsModel: result.data.TTS_MODEL,
    ttsSpeaker: result.data.TTS_SPEAKER,
    asrRequestTimeoutMs: result.data.ASR_REQUEST_TIMEOUT_MS,
    ttsRequestTimeoutMs: result.data.TTS_REQUEST_TIMEOUT_MS,
    performanceLogging: result.data.SHIVA_PERF_LOG,
    nodeEnv: result.data.NODE_ENV,
  };
}

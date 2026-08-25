import { BedrockProvider, type BedrockCredentials } from "./bedrock-provider";
import type { AIProvider } from "./ai-provider";
import { GeminiProvider } from "./gemini-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenAiProvider } from "./openai-provider";

export interface ChatProviderConfig {
  readonly brainProvider: "ollama" | "gemini" | "openai" | "bedrock";
  readonly model: string;
  readonly geminiApiKey?: string;
  readonly openaiApiKey?: string;
  readonly awsBearerTokenBedrock?: string;
  readonly awsAccessKeyId?: string;
  readonly awsSecretAccessKey?: string;
  readonly awsSessionToken?: string;
  readonly awsRegion?: string;
  readonly ollamaUrl: string;
  readonly contextLength: number;
  readonly keepAlive: string | number;
  readonly ollamaRequestTimeoutMs: number;
}

/** Selects the chat brain named by `SHIVA_BRAIN_PROVIDER` — local Ollama, the Gemini API, the OpenAI API, or AWS Bedrock. */
export function createChatProvider(config: ChatProviderConfig): AIProvider {
  if (config.brainProvider === "ollama") {
    return new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      contextLength: config.contextLength,
      keepAlive: config.keepAlive,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
  }

  if (config.brainProvider === "openai") {
    if (!config.openaiApiKey) {
      // Config loading requires OPENAI_API_KEY whenever brainProvider is
      // "openai" (see environmentSchema's superRefine), so this only fires
      // if a caller builds ChatProviderConfig by hand instead of from
      // AppConfig.
      throw new Error("OPENAI_API_KEY is required when SHIVA_BRAIN_PROVIDER=openai.");
    }
    return new OpenAiProvider({
      apiKey: config.openaiApiKey,
      model: config.model,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
  }

  if (config.brainProvider === "bedrock") {
    // A Bedrock API key (bearer token) is the simpler mechanism — no request
    // signing — and is preferred when present; IAM access keys fall back to
    // classic SigV4 signing. Config loading requires one or the other
    // whenever brainProvider is "bedrock" (see environmentSchema's
    // superRefine), so the throw below only fires if a caller builds
    // ChatProviderConfig by hand instead of from AppConfig.
    const credentials: BedrockCredentials | undefined = config.awsBearerTokenBedrock
      ? { type: "bearer", token: config.awsBearerTokenBedrock }
      : config.awsAccessKeyId && config.awsSecretAccessKey
        ? {
            type: "sigv4",
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey,
            ...(config.awsSessionToken
              ? { sessionToken: config.awsSessionToken }
              : {}),
          }
        : undefined;
    if (!credentials) {
      throw new Error(
        "AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, is required when SHIVA_BRAIN_PROVIDER=bedrock.",
      );
    }
    return new BedrockProvider({
      credentials,
      region: config.awsRegion ?? "us-east-1",
      model: config.model,
      requestTimeoutMs: config.ollamaRequestTimeoutMs,
    });
  }

  if (!config.geminiApiKey) {
    // Config loading requires GEMINI_API_KEY whenever brainProvider is
    // "gemini" (see environmentSchema's superRefine), so this only fires if
    // a caller builds ChatProviderConfig by hand instead of from AppConfig.
    throw new Error("GEMINI_API_KEY is required when SHIVA_BRAIN_PROVIDER=gemini.");
  }

  return new GeminiProvider({
    apiKey: config.geminiApiKey,
    model: config.model,
    requestTimeoutMs: config.ollamaRequestTimeoutMs,
  });
}

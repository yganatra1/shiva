import type { AIProvider } from "./ai-provider";
import { GeminiProvider } from "./gemini-provider";
import { OllamaProvider } from "./ollama-provider";

export interface ChatProviderConfig {
  readonly brainProvider: "ollama" | "gemini";
  readonly model: string;
  readonly geminiApiKey?: string;
  readonly ollamaUrl: string;
  readonly contextLength: number;
  readonly keepAlive: string | number;
  readonly ollamaRequestTimeoutMs: number;
}

/** Selects the chat brain named by `SHIVA_BRAIN_PROVIDER` — local Ollama or the Gemini API. */
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

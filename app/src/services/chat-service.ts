import type { AIProvider } from "../brain/ai-provider.js";
import { SHIVA_SYSTEM_PROMPT } from "../brain/system-prompt.js";

export class ShivaChatService {
  constructor(private readonly provider: AIProvider) {}

  async respondTo(message: string, signal?: AbortSignal): Promise<string> {
    const messages = [
      { role: "system" as const, content: SHIVA_SYSTEM_PROMPT },
      { role: "user" as const, content: message },
    ];
    const result = await this.provider.chat({
      messages,
      ...(signal ? { signal } : {}),
    });

    return result.content;
  }
}

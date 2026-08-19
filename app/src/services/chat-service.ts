import type {
  AIProvider,
  ChatChunk,
  ChatInput,
} from "../brain/ai-provider.js";
import { SHIVA_SYSTEM_PROMPT } from "../brain/system-prompt.js";

export class ShivaChatService {
  constructor(private readonly provider: AIProvider) {}

  async respondTo(message: string, signal?: AbortSignal): Promise<string> {
    const result = await this.provider.chat(this.buildInput(message, signal));

    return result.content;
  }

  streamResponseTo(
    message: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    return this.provider.streamChat(this.buildInput(message, signal));
  }

  private buildInput(message: string, signal?: AbortSignal): ChatInput {
    return {
      messages: [
        { role: "system", content: SHIVA_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      ...(signal ? { signal } : {}),
    };
  }
}

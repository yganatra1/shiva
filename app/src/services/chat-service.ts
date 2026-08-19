import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
} from "../brain/ai-provider.js";
import { SHIVA_SYSTEM_PROMPT } from "../brain/system-prompt.js";
import { isFillerMessage, type MemoryService } from "../memory/memory-service.js";
import type { MemoryRetriever } from "../memory/memory-retriever.js";
import type {
  MemoryRepositoryPort,
  StoredMessage,
} from "../memory/types.js";

interface ShivaChatServiceOptions {
  readonly provider: AIProvider;
  readonly repository: MemoryRepositoryPort;
  readonly memoryRetriever: MemoryRetriever;
  readonly memoryService: MemoryService;
  readonly userId: string;
  readonly userName: string;
  readonly workingMemoryMessageLimit: number;
  readonly onBackgroundError?: (error: unknown) => void;
}

export interface PreparedChat {
  readonly conversationId: string;
  readonly chunks: AsyncIterable<ChatChunk>;
}

export class ShivaChatService {
  constructor(private readonly options: ShivaChatServiceOptions) {}

  async startResponseTo(
    message: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<PreparedChat> {
    await this.options.repository.ensureUser(
      this.options.userId,
      this.options.userName,
    );
    const conversation = await this.options.repository.resolveConversation(
      this.options.userId,
      conversationId,
    );
    const userMessage = await this.options.repository.addMessage(
      conversation.id,
      "user",
      message,
    );
    const recentMessages = await this.options.repository.getRecentMessages(
      conversation.id,
      this.options.workingMemoryMessageLimit,
    );
    const relevantMemory = isFillerMessage(message)
      ? { memories: [] }
      : await this.retrieveMemorySafely(message, signal);
    const messages = buildMessages(recentMessages, relevantMemory.systemMessage);

    return {
      conversationId: conversation.id,
      chunks: this.streamAndPersist(
        conversation.id,
        userMessage,
        recentMessages,
        messages,
        signal,
      ),
    };
  }

  private async retrieveMemorySafely(
    message: string,
    signal?: AbortSignal,
  ) {
    try {
      return await this.options.memoryRetriever.retrieve(
        this.options.userId,
        message,
        signal,
      );
    } catch (error: unknown) {
      if (signal?.aborted) {
        throw error;
      }
      this.options.onBackgroundError?.(error);
      return { memories: [] };
    }
  }

  private async *streamAndPersist(
    conversationId: string,
    userMessage: StoredMessage,
    recentMessages: readonly StoredMessage[],
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    let assistantResponse = "";
    const input = signal ? { messages, signal } : { messages };

    for await (const chunk of this.options.provider.streamChat(input)) {
      assistantResponse += chunk.content;
      yield chunk;
    }

    if (assistantResponse.trim().length === 0) {
      return;
    }

    await this.options.repository.addMessage(
      conversationId,
      "assistant",
      assistantResponse,
    );

    setImmediate(() => {
      void this.options.memoryService
        .rememberInteraction({
          userId: this.options.userId,
          conversationId,
          userMessage,
          assistantResponse,
          recentMessages,
        })
        .catch((error: unknown) => {
          this.options.onBackgroundError?.(error);
        });
    });
  }
}

function buildMessages(
  recentMessages: readonly StoredMessage[],
  memoryContext?: ChatMessage,
): readonly ChatMessage[] {
  return [
    { role: "system", content: SHIVA_SYSTEM_PROMPT },
    ...(memoryContext ? [memoryContext] : []),
    ...recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

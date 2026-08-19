import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
} from "../brain/ai-provider.js";
import { SHIVA_SYSTEM_PROMPT } from "../brain/system-prompt.js";
import {
  isExplicitMemoryRequest,
  isFillerMessage,
  type ExplicitMemoryResult,
  type MemoryService,
} from "../memory/memory-service.js";
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
    const explicitRequest = isExplicitMemoryRequest(message);
    const explicitMemory = explicitRequest
      ? await this.options.memoryService.rememberExplicitInteraction({
          userId: this.options.userId,
          conversationId: conversation.id,
          userMessage,
          assistantResponse: "",
          recentMessages,
          ...(signal ? { signal } : {}),
        })
      : undefined;
    const relevantMemory = isFillerMessage(message)
      ? { memories: [] }
      : await this.retrieveMemorySafely(message, signal);
    const messages = buildMessages(
      recentMessages,
      relevantMemory.systemMessage,
      explicitMemory,
    );

    return {
      conversationId: conversation.id,
      chunks: this.streamAndPersist(
        conversation.id,
        userMessage,
        recentMessages,
        messages,
        !explicitRequest,
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
    deferMemoryExtraction: boolean,
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

    if (!deferMemoryExtraction) {
      return;
    }

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
  explicitMemory?: ExplicitMemoryResult,
): readonly ChatMessage[] {
  return [
    { role: "system", content: SHIVA_SYSTEM_PROMPT },
    ...(explicitMemory ? [explicitMemoryInstruction(explicitMemory)] : []),
    ...(memoryContext ? [memoryContext] : []),
    ...recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

function explicitMemoryInstruction(result: ExplicitMemoryResult): ChatMessage {
  if (result.stored.length > 0) {
    return {
      role: "system",
      content: `The user's explicit memory request completed successfully and ${result.stored.length} atomic memory item(s) were persisted before this response. You may acknowledge only that the information has already been remembered. Use past or present-perfect wording; do not promise a future save.`,
    };
  }

  if (result.duplicateCount > 0) {
    return {
      role: "system",
      content:
        "The user's explicit memory request completed successfully, and the information was already present in memory. You may accurately say it is already remembered.",
    };
  }

  return {
    role: "system",
    content:
      "No material information from the explicit memory request was persisted. Do not claim that it was remembered and do not say that you will remember it.",
  };
}

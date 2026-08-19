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
import {
  measureChatPerformance,
  measureChatPerformanceSync,
  type ChatPerformanceTrace,
} from "../observability/chat-performance.js";

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

export type ChatInteractionMode = "text" | "voice";

export interface ChatInteractionContext {
  readonly mode: ChatInteractionMode;
  readonly performance?: ChatPerformanceTrace;
}

const VOICE_RESPONSE_GUIDANCE: ChatMessage = {
  role: "system",
  content:
    "This interaction is being spoken aloud. Respond conversationally and concisely in natural speech. Avoid markdown, tables, headings, long lists, and unnecessary formatting. Prefer short sentences and only include detail that is useful when heard.",
};

export class ShivaChatService {
  constructor(private readonly options: ShivaChatServiceOptions) {}

  async startResponseTo(
    message: string,
    conversationId?: string,
    signal?: AbortSignal,
    interaction: ChatInteractionContext = { mode: "text" },
  ): Promise<PreparedChat> {
    const performance = interaction.performance;
    await measureChatPerformance(performance, "resolve-user", () =>
      this.options.repository.ensureUser(
        this.options.userId,
        this.options.userName,
      ),
    );
    const conversation = await measureChatPerformance(
      performance,
      "conversation",
      () =>
        this.options.repository.resolveConversation(
          this.options.userId,
          conversationId,
        ),
    );
    performance?.setConversationId(conversation.id);
    const userMessage = await measureChatPerformance(
      performance,
      "save-message",
      () => this.options.repository.addMessage(conversation.id, "user", message),
    );
    const recentMessages = await measureChatPerformance(
      performance,
      "working-memory",
      () =>
        this.options.repository.getRecentMessages(
          conversation.id,
          this.options.workingMemoryMessageLimit,
        ),
    );
    const explicitRequest = isExplicitMemoryRequest(message);
    const explicitMemory = explicitRequest
      ? await measureChatPerformance(performance, "explicit-memory", () =>
          this.options.memoryService.rememberExplicitInteraction({
            userId: this.options.userId,
            conversationId: conversation.id,
            userMessage,
            assistantResponse: "",
            recentMessages,
            ...(signal ? { signal } : {}),
          }),
        )
      : undefined;
    const relevantMemory = isFillerMessage(message)
      ? { memories: [] }
      : await this.retrieveMemorySafely(message, signal, performance);
    const messages = measureChatPerformanceSync(
      performance,
      "prompt-build",
      () =>
        buildMessages(
          recentMessages,
          relevantMemory.systemMessage,
          explicitMemory,
          interaction.mode,
        ),
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
        performance,
      ),
    };
  }

  private async retrieveMemorySafely(
    message: string,
    signal?: AbortSignal,
    performance?: ChatPerformanceTrace,
  ) {
    try {
      return await this.options.memoryRetriever.retrieve(
        this.options.userId,
        message,
        signal,
        performance,
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
    performance?: ChatPerformanceTrace,
  ): AsyncIterable<ChatChunk> {
    let assistantResponse = "";
    const input = signal ? { messages, signal } : { messages };

    performance?.markBeforeOllama();
    try {
      for await (const chunk of this.options.provider.streamChat(input)) {
        performance?.markOllamaFirstToken();
        assistantResponse += chunk.content;
        yield chunk;
      }
    } finally {
      performance?.markOllamaComplete();
    }

    if (assistantResponse.trim().length === 0) {
      return;
    }

    await measureChatPerformance(performance, "save-assistant", () =>
      this.options.repository.addMessage(
        conversationId,
        "assistant",
        assistantResponse,
      ),
    );

    if (!deferMemoryExtraction) {
      return;
    }

    const schedulingStartedAt = performance?.now();
    const scheduledAt = schedulingStartedAt;
    setImmediate(() => {
      const extractionStartedAt = performance?.now();
      let extractionOutcome: "success" | "error" = "success";
      void this.options.memoryService
        .rememberInteraction({
          userId: this.options.userId,
          conversationId,
          userMessage,
          assistantResponse,
          recentMessages,
        })
        .catch((error: unknown) => {
          extractionOutcome = "error";
          this.options.onBackgroundError?.(error);
        })
        .finally(() => {
          if (
            performance &&
            scheduledAt !== undefined &&
            extractionStartedAt !== undefined
          ) {
            performance.finishAsyncMemory(
              conversationId,
              scheduledAt,
              extractionStartedAt,
              extractionOutcome,
            );
          }
        });
    });
    if (performance && schedulingStartedAt !== undefined) {
      performance.record(
        "memory-schedule",
        performance.now() - schedulingStartedAt,
      );
    }
  }
}

function buildMessages(
  recentMessages: readonly StoredMessage[],
  memoryContext?: ChatMessage,
  explicitMemory?: ExplicitMemoryResult,
  interactionMode: ChatInteractionMode = "text",
): readonly ChatMessage[] {
  return [
    { role: "system", content: SHIVA_SYSTEM_PROMPT },
    ...(interactionMode === "voice" ? [VOICE_RESPONSE_GUIDANCE] : []),
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

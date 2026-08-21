import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
} from "../brain/ai-provider.js";
import type { AgentOrchestratorPort } from "../agent/types.js";
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
  readonly timeZone: string;
  readonly workingMemoryMessageLimit: number;
  readonly agentOrchestrator?: AgentOrchestratorPort;
  readonly automaticMemoryGate?: {
    waitUntilReady(): Promise<boolean>;
    isClosed(): boolean;
  };
  readonly onBackgroundError?: (error: unknown) => void;
}

interface DeferredMemoryJob {
  readonly conversationId: string;
  readonly userMessage: StoredMessage;
  readonly assistantResponse: string;
  readonly recentMessages: readonly StoredMessage[];
  readonly performance?: ChatPerformanceTrace;
  readonly scheduledAt?: number;
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
    "This interaction is being spoken aloud. Respond conversationally and concisely in smooth, connected natural speech. Avoid markdown, tables, headings, long lists, choppy fragments, and unnecessary formatting. Use moderately sized spoken phrases and only include detail that is useful when heard.",
};

const PLANNER_FALLBACK_GUIDANCE: ChatMessage = {
  role: "system",
  content:
    "The tool planner could not produce a safe executable plan for this turn. Respond with Shiva's core conversational reasoning only. Do not claim that a tool, live source, workspace operation, or external action was used. If the request requires current information or an action, say plainly that it could not be completed in this turn.",
};

export class ShivaChatService {
  private backgroundMemoryTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ShivaChatServiceOptions) {}

  async drainBackgroundMemory(): Promise<void> {
    await this.backgroundMemoryTail;
  }

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
    const agentResult =
      !explicitRequest && this.options.agentOrchestrator
        ? await this.options.agentOrchestrator.run({
            userMessage: message,
            conversationId: conversation.id,
            userId: this.options.userId,
            userName: this.options.userName,
            timeZone: this.options.timeZone,
            // The agent planner owns its system contract. Preserve voice,
            // memory, and conversation context without injecting the direct
            // chat system prompt as a competing planner instruction.
            contextMessages: messages.slice(1),
            ...(signal ? { signal } : {}),
          })
        : undefined;

    const responseMessages =
      agentResult?.kind === "direct_chat" && agentResult.plannerFallback
        ? [messages[0] ?? { role: "system", content: SHIVA_SYSTEM_PROMPT }, PLANNER_FALLBACK_GUIDANCE, ...messages.slice(1)]
        : messages;

    return {
      conversationId: conversation.id,
      chunks: this.streamAndPersist(
        conversation.id,
        userMessage,
        recentMessages,
        responseMessages,
        !explicitRequest,
        agentResult?.kind === "response" ? agentResult.response : undefined,
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
    agentResponse?: string,
    signal?: AbortSignal,
    performance?: ChatPerformanceTrace,
  ): AsyncIterable<ChatChunk> {
    let assistantResponse = "";
    if (agentResponse !== undefined) {
      performance?.markResponseFirstToken();
      assistantResponse = agentResponse;
      yield { content: agentResponse };
    } else {
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
      this.enqueueDeferredMemoryExtraction({
        conversationId,
        userMessage,
        assistantResponse,
        recentMessages,
        ...(performance ? { performance } : {}),
        ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      });
    });
    if (performance && schedulingStartedAt !== undefined) {
      performance.record(
        "memory-schedule",
        performance.now() - schedulingStartedAt,
      );
    }
  }

  private enqueueDeferredMemoryExtraction(input: DeferredMemoryJob): void {
    const job = this.backgroundMemoryTail.then(() =>
      this.runDeferredMemoryExtraction(input),
    );
    this.backgroundMemoryTail = job.catch((error: unknown) => {
      this.options.onBackgroundError?.(error);
    });
  }

  private async runDeferredMemoryExtraction(
    input: DeferredMemoryJob,
  ): Promise<void> {
    const gate = this.options.automaticMemoryGate;
    if (gate) {
      let ready = false;
      try {
        ready = await gate.waitUntilReady();
      } catch (error: unknown) {
        this.options.onBackgroundError?.(error);
        return;
      }
      if (!ready || gate.isClosed()) {
        return;
      }
    }

    const extractionStartedAt = input.performance?.now();
    let extractionOutcome: "success" | "error" = "success";
    try {
      await this.options.memoryService.rememberInteraction({
        userId: this.options.userId,
        conversationId: input.conversationId,
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
        recentMessages: input.recentMessages,
      });
    } catch (error: unknown) {
      extractionOutcome = "error";
      this.options.onBackgroundError?.(error);
    } finally {
      if (
        input.performance &&
        input.scheduledAt !== undefined &&
        extractionStartedAt !== undefined
      ) {
        input.performance.finishAsyncMemory(
          input.conversationId,
          input.scheduledAt,
          extractionStartedAt,
          extractionOutcome,
        );
      }
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

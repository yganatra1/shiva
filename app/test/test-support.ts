import type { AppOverrides } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import type { EmbeddingProvider } from "../src/brain/embedding-provider.js";
import type { AppConfig } from "../src/config/environment.js";
import { ConversationNotFoundError } from "../src/memory/memory-repository.js";
import type {
  Conversation,
  AddMessageOptions,
  ConversationCursor,
  ConversationSummary,
  ExtractedMemory,
  MemoryExtractionEngine,
  MemoryExtractionInput,
  MemoryRecord,
  MemoryRelationshipResult,
  MemoryRepositoryPort,
  MemorySearchResult,
  MemoryType,
  MessageCursor,
  NewMemoryInput,
  SemanticMemoryType,
  StoredMessage,
  StoredMessageRole,
} from "../src/memory/types.js";
import { EMBEDDING_DIMENSIONS } from "../src/types/embedding.js";

export const testConfig: AppConfig = {
  port: 3000,
  host: "127.0.0.1",
  brainProvider: "gemini",
  ollamaUrl: "http://127.0.0.1:11434",
  model: "test-model",
  geminiApiKey: "test-gemini-api-key",
  awsRegion: "us-east-1",
  contextLength: 16_384,
  keepAlive: "30m",
  ollamaRequestTimeoutMs: 1_000,
  databaseUrl: "postgresql://test:test@127.0.0.1:5432/test",
  databasePoolMax: 2,
  databaseSsl: false,
  redisUrl: "redis://127.0.0.1:6379",
  userId: "00000000-0000-4000-8000-000000000001",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  schedulerCoreUrl: "http://127.0.0.1:3000",
  schedulerToken: "test-scheduler-token-that-is-long-enough",
  schedulerDatabasePoolMax: 2,
  schedulerCoreTimeoutMs: 330_000,
  schedulerProcessingUncertainAfterMs: 600_000,
  schedulerQueueOptions: {
    retryLimit: 5,
    retryDelaySeconds: 5,
    expireInSeconds: 600,
    heartbeatSeconds: 30,
    retentionSeconds: 31_536_000,
    deleteAfterSeconds: 2_592_000,
  },
  agentMaxSteps: 8,
  agentRequestTimeoutMs: 300_000,
  agentTaskTimeoutMs: 300_000,
  agentReclaimIdleMs: 30_000,
  agentMaxDeliveryAttempts: 3,
  agentHeartbeatTtlSeconds: 15,
  maxExecutionMode: "FULL_ACCESS",
  confirmationTtlMs: 300_000,
  expenseSheetRequestTimeoutMs: 1_000,
  braveSearchUrl: "https://api.search.brave.com",
  webRequestTimeoutMs: 1_000,
  webMaxContentBytes: 64 * 1024,
  embeddingModel: "test-embedding",
  embeddingRequestTimeoutMs: 1_000,
  workingMemoryMessageLimit: 20,
  memoryRetrievalLimit: 8,
  asrServiceUrl: "http://127.0.0.1:8101",
  ttsServiceUrl: "http://127.0.0.1:8102",
  faceServiceUrl: "http://127.0.0.1:8103",
  deviceAgentUrl: "http://127.0.0.1:3002",
  deviceAgentHost: "127.0.0.1",
  deviceAgentPort: 3002,
  deviceAgentMaxSteps: 15,
  asrModel: "test-asr-model",
  ttsModel: "test-tts-model",
  ttsSpeaker: "Aiden",
  asrRequestTimeoutMs: 1_000,
  ttsRequestTimeoutMs: 1_000,
  faceRequestTimeoutMs: 1_000,
  faceMatchThreshold: 0.5,
  faceEnrollmentThreshold: 0.35,
  faceAmbiguityMargin: 0.03,
  performanceLogging: false,
  agentTraceLog: false,
  nodeEnv: "test",
};

export const fixedEmbedding = Array.from(
  { length: EMBEDDING_DIMENSIONS },
  (_value, index) => index / EMBEDDING_DIMENSIONS,
);

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly texts: string[] = [];

  async embed(input: { readonly text: string }): Promise<readonly number[]> {
    this.texts.push(input.text);
    return fixedEmbedding;
  }
}

export class FakeExtractionEngine implements MemoryExtractionEngine {
  extracted: readonly ExtractedMemory[] = [];
  relationship: MemoryRelationshipResult = {
    relationship: "unrelated",
    confidence: 1,
  };
  relationshipResolver?: (
    existing: MemoryRecord,
    candidate: ExtractedMemory,
  ) => MemoryRelationshipResult;
  failure?: Error;

  async extract(
    _input: MemoryExtractionInput,
  ): Promise<readonly ExtractedMemory[]> {
    if (this.failure) {
      throw this.failure;
    }
    return this.extracted;
  }

  async classifyRelationship(
    existing: MemoryRecord,
    candidate: ExtractedMemory,
  ): Promise<MemoryRelationshipResult> {
    return this.relationshipResolver?.(existing, candidate) ?? this.relationship;
  }
}

export class InMemoryRepository implements MemoryRepositoryPort {
  readonly conversations = new Map<string, Conversation>();
  readonly messages: StoredMessage[] = [];
  readonly memories: MemoryRecord[] = [];
  readonly touchedMemoryIds: string[] = [];
  semanticSearchResults: readonly MemorySearchResult[] = [];
  episodicSearchResults: readonly MemorySearchResult[] = [];
  similarSemanticResults: readonly MemorySearchResult[] = [];
  private sequence = 1;

  async ensureUser(_userId: string, _displayName: string): Promise<void> {}

  async resolveConversation(
    userId: string,
    conversationId?: string,
  ): Promise<Conversation> {
    if (conversationId) {
      const existing = this.conversations.get(conversationId);
      if (!existing || existing.userId !== userId) {
        throw new ConversationNotFoundError();
      }
      return existing;
    }

    const now = new Date();
    const conversation: Conversation = {
      id: this.nextUuid(),
      userId,
      title: null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async listConversations(
    userId: string,
    limit: number,
    before?: ConversationCursor,
  ): Promise<readonly ConversationSummary[]> {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.userId === userId)
      .filter((conversation) => {
        if (!before) return true;
        const difference =
          conversation.lastMessageAt.getTime() - before.lastMessageAt.getTime();
        return difference < 0 || (difference === 0 && conversation.id < before.id);
      })
      .sort(
        (left, right) =>
          right.lastMessageAt.getTime() - left.lastMessageAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map((conversation) => ({
        ...conversation,
        messageCount: this.messages.filter(
          (message) => message.conversationId === conversation.id,
        ).length,
      }));
  }

  async listConversationMessages(
    userId: string,
    conversationId: string,
    limit: number,
    before?: MessageCursor,
  ): Promise<readonly StoredMessage[]> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return [];
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .filter((message) => {
        if (!before) return true;
        const difference = message.createdAt.getTime() - before.createdAt.getTime();
        return difference < 0 || (difference === 0 && message.id < before.id);
      })
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit);
  }

  async searchConversationMessages(
    userId: string,
    query: string,
    limit: number,
  ): Promise<readonly StoredMessage[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const conversationIds = new Set(
      [...this.conversations.values()]
        .filter((conversation) => conversation.userId === userId)
        .map((conversation) => conversation.id),
    );
    return this.messages
      .filter(
        (message) =>
          conversationIds.has(message.conversationId) &&
          message.content.toLowerCase().includes(normalizedQuery),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit);
  }

  async updateConversationTitle(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation | null> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return null;
    const updated = { ...conversation, title, updatedAt: new Date() };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async setConversationTitleIfEmpty(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId || conversation.title) return;
    this.conversations.set(conversationId, {
      ...conversation,
      title,
      updatedAt: new Date(),
    });
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return false;
    this.conversations.delete(conversationId);
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.conversationId === conversationId) {
        this.messages.splice(index, 1);
      }
    }
    return true;
  }

  async addMessage(
    conversationId: string,
    role: StoredMessageRole,
    content: string,
    options?: AddMessageOptions,
  ): Promise<StoredMessage> {
    if (options?.sourceId) {
      const existing = this.messages.find(
        (message) =>
          message.source === options.source &&
          message.sourceId === options.sourceId &&
          message.role === role,
      );
      if (existing) return existing;
    }
    const message: StoredMessage = {
      id: this.nextUuid(),
      conversationId,
      role,
      content,
      source: options?.source ?? "chat",
      sourceId: options?.sourceId ?? null,
      metadata: { ...(options?.metadata ?? {}) },
      createdAt: new Date(Date.now() + this.sequence),
    };
    this.messages.push(message);
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      this.conversations.set(conversationId, {
        ...conversation,
        updatedAt: message.createdAt,
        lastMessageAt: message.createdAt,
      });
    }
    return message;
  }

  async getMessageById(messageId: string): Promise<StoredMessage | undefined> {
    return this.messages.find((message) => message.id === messageId);
  }

  async getRecentMessages(
    conversationId: string,
    limit: number,
  ): Promise<readonly StoredMessage[]> {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .slice(-limit);
  }

  async searchMemories(
    _userId: string,
    memoryType: MemoryType,
    _embedding: readonly number[],
    limit: number,
  ): Promise<readonly MemorySearchResult[]> {
    return (memoryType === "semantic"
      ? this.semanticSearchResults
      : this.episodicSearchResults
    ).slice(0, limit);
  }

  async findSimilarSemanticMemories(
    _userId: string,
    _semanticType: SemanticMemoryType,
    _embedding: readonly number[],
    _minimumSimilarity: number,
    limit: number,
  ): Promise<readonly MemorySearchResult[]> {
    return this.similarSemanticResults.slice(0, limit);
  }

  async saveMemory(
    input: NewMemoryInput,
    supersedesIds: readonly string[] = [],
  ): Promise<MemoryRecord> {
    const now = new Date();
    const memory: MemoryRecord = {
      id: this.nextUuid(),
      userId: input.userId,
      memoryType: input.memoryType,
      semanticType: input.semanticType,
      content: input.content,
      importance: input.importance,
      confidence: input.confidence,
      occurredAt: input.occurredAt,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      status: "active",
      supersededBy: null,
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
    };
    this.memories.push(memory);

    for (const supersedesId of new Set(supersedesIds)) {
      const index = this.memories.findIndex((item) => item.id === supersedesId);
      const existing = this.memories[index];
      if (index < 0 || !existing || existing.status !== "active") {
        throw new Error("Missing active superseded memory.");
      }
      this.memories[index] = {
        ...existing,
        status: "superseded",
        supersededBy: memory.id,
      };
    }
    return memory;
  }

  async touchMemories(memoryIds: readonly string[]): Promise<void> {
    this.touchedMemoryIds.push(...memoryIds);
  }

  async archiveMemory(userId: string, memoryId: string): Promise<boolean> {
    const index = this.memories.findIndex(
      (memory) =>
        memory.id === memoryId &&
        memory.userId === userId &&
        memory.status === "active",
    );
    if (index < 0) return false;
    const existing = this.memories[index];
    if (!existing) return false;
    this.memories[index] = { ...existing, status: "archived" };
    return true;
  }

  async listActiveMemories(
    userId: string,
    limit: number,
  ): Promise<readonly MemoryRecord[]> {
    return this.memories
      .filter((memory) => memory.userId === userId && memory.status === "active")
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  async updateMemoryEmbedding(
    userId: string,
    memoryId: string,
    _embedding: readonly number[],
  ): Promise<boolean> {
    const index = this.memories.findIndex(
      (memory) =>
        memory.id === memoryId &&
        memory.userId === userId &&
        memory.status === "active",
    );
    if (index < 0) return false;
    this.refreshedEmbeddingIds.push(memoryId);
    return true;
  }

  readonly refreshedEmbeddingIds: string[] = [];

  private nextUuid(): string {
    const suffix = String(this.sequence++).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

export function createTestOverrides(
  provider: AIProvider,
  repository = new InMemoryRepository(),
  embeddingProvider = new FakeEmbeddingProvider(),
  extractionEngine = new FakeExtractionEngine(),
): AppOverrides {
  return { provider, repository, embeddingProvider, extractionEngine };
}

export function memoryResult(
  overrides: Partial<MemorySearchResult> = {},
): MemorySearchResult {
  const now = new Date();
  return {
    id: "10000000-0000-4000-8000-000000000001",
    userId: testConfig.userId,
    memoryType: "semantic",
    semanticType: "fact",
    content: "Yash prefers aisle seats.",
    importance: 0.8,
    confidence: 0.95,
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    status: "active",
    supersededBy: null,
    sourceConversationId: null,
    sourceMessageId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    accessCount: 0,
    similarity: 0.9,
    ...overrides,
  };
}

import type { AppOverrides } from "../src/app.js";
import type { AIProvider } from "../src/brain/ai-provider.js";
import type { EmbeddingProvider } from "../src/brain/embedding-provider.js";
import type { AppConfig } from "../src/config/environment.js";
import { ConversationNotFoundError } from "../src/memory/memory-repository.js";
import type {
  Conversation,
  ExtractedMemory,
  MemoryExtractionEngine,
  MemoryExtractionInput,
  MemoryRecord,
  MemoryRelationshipResult,
  MemoryRepositoryPort,
  MemorySearchResult,
  MemoryType,
  NewMemoryInput,
  SemanticMemoryType,
  StoredMessage,
  StoredMessageRole,
} from "../src/memory/types.js";
import { EMBEDDING_DIMENSIONS } from "../src/types/embedding.js";

export const testConfig: AppConfig = {
  port: 3000,
  host: "127.0.0.1",
  ollamaUrl: "http://127.0.0.1:11434",
  model: "test-model",
  contextLength: 16_384,
  keepAlive: "30m",
  ollamaRequestTimeoutMs: 1_000,
  databaseUrl: "postgresql://test:test@127.0.0.1:5432/test",
  databasePoolMax: 2,
  databaseSsl: false,
  userId: "00000000-0000-4000-8000-000000000001",
  userName: "Yash",
  timeZone: "Asia/Kolkata",
  agentMaxSteps: 8,
  agentRequestTimeoutMs: 300_000,
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
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async addMessage(
    conversationId: string,
    role: StoredMessageRole,
    content: string,
  ): Promise<StoredMessage> {
    const message: StoredMessage = {
      id: this.nextUuid(),
      conversationId,
      role,
      content,
      createdAt: new Date(Date.now() + this.sequence),
    };
    this.messages.push(message);
    return message;
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

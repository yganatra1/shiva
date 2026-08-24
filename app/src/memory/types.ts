import type { ChatMessage } from "../brain/ai-provider";

export type MemoryType = "episodic" | "semantic";
export type SemanticMemoryType =
  | "fact"
  | "preference"
  | "relationship"
  | "project_fact"
  | "profile";
export type MemoryStatus = "active" | "superseded" | "archived";
export type StoredMessageRole = "user" | "assistant";
export type MemoryRelationship =
  | "duplicate"
  | "update"
  | "contradiction"
  | "unrelated";

export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly title: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastMessageAt: Date;
}

export interface ConversationSummary extends Conversation {
  readonly messageCount: number;
}

export interface ConversationCursor {
  readonly lastMessageAt: Date;
  readonly id: string;
}

export interface MessageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: StoredMessageRole;
  readonly content: string;
  readonly createdAt: Date;
}

export interface MemoryRecord {
  readonly id: string;
  readonly userId: string;
  readonly memoryType: MemoryType;
  readonly semanticType: SemanticMemoryType | null;
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly occurredAt: Date | null;
  readonly validFrom: Date | null;
  readonly validUntil: Date | null;
  readonly status: MemoryStatus;
  readonly supersededBy: string | null;
  readonly sourceConversationId: string | null;
  readonly sourceMessageId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastAccessedAt: Date | null;
  readonly accessCount: number;
}

export interface MemorySearchResult extends MemoryRecord {
  readonly similarity: number;
}

export interface RankedMemory extends MemorySearchResult {
  readonly score: number;
}

export interface NewMemoryInput {
  readonly userId: string;
  readonly memoryType: MemoryType;
  readonly semanticType: SemanticMemoryType | null;
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly occurredAt: Date | null;
  readonly validFrom: Date | null;
  readonly validUntil: Date | null;
  readonly sourceConversationId: string;
  readonly sourceMessageId: string;
  readonly embedding: readonly number[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ExtractedMemory {
  readonly memoryType: MemoryType;
  readonly semanticType: SemanticMemoryType | null;
  readonly content: string;
  readonly importance: number;
  readonly confidence: number;
  readonly occurredAt: Date | null;
  readonly validFrom: Date | null;
  readonly validUntil: Date | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MemoryExtractionInput {
  readonly userMessage: string;
  readonly assistantResponse: string;
  readonly recentMessages: readonly StoredMessage[];
  readonly explicitRequest?: boolean;
  readonly signal?: AbortSignal;
}

export interface RememberInteractionInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly userMessage: StoredMessage;
  readonly assistantResponse: string;
  readonly recentMessages: readonly StoredMessage[];
  readonly signal?: AbortSignal;
}

export interface MemoryRelationshipResult {
  readonly relationship: MemoryRelationship;
  readonly confidence: number;
}

export interface MemoryExtractionEngine {
  extract(input: MemoryExtractionInput): Promise<readonly ExtractedMemory[]>;
  classifyRelationship(
    existing: MemoryRecord,
    candidate: ExtractedMemory,
    signal?: AbortSignal,
  ): Promise<MemoryRelationshipResult>;
}

export interface MemoryRepositoryPort {
  ensureUser(userId: string, displayName: string): Promise<void>;
  resolveConversation(
    userId: string,
    conversationId?: string,
  ): Promise<Conversation>;
  listConversations(
    userId: string,
    limit: number,
    before?: ConversationCursor,
  ): Promise<readonly ConversationSummary[]>;
  listConversationMessages(
    userId: string,
    conversationId: string,
    limit: number,
    before?: MessageCursor,
  ): Promise<readonly StoredMessage[]>;
  updateConversationTitle(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation | null>;
  setConversationTitleIfEmpty(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<void>;
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  addMessage(
    conversationId: string,
    role: StoredMessageRole,
    content: string,
  ): Promise<StoredMessage>;
  getRecentMessages(
    conversationId: string,
    limit: number,
  ): Promise<readonly StoredMessage[]>;
  searchMemories(
    userId: string,
    memoryType: MemoryType,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly MemorySearchResult[]>;
  findSimilarSemanticMemories(
    userId: string,
    semanticType: SemanticMemoryType,
    embedding: readonly number[],
    minimumSimilarity: number,
    limit: number,
  ): Promise<readonly MemorySearchResult[]>;
  saveMemory(
    input: NewMemoryInput,
    supersedesIds?: readonly string[],
  ): Promise<MemoryRecord>;
  touchMemories(memoryIds: readonly string[]): Promise<void>;
}

export interface RelevantMemoryContext {
  readonly memories: readonly RankedMemory[];
  readonly systemMessage?: ChatMessage;
}

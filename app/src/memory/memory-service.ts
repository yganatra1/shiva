import type { EmbeddingProvider } from "../brain/embedding-provider.js";
import type {
  ExtractedMemory,
  MemoryExtractionEngine,
  MemoryRecord,
  MemoryRelationshipResult,
  MemoryRepositoryPort,
  RememberInteractionInput,
} from "./types.js";

const SEMANTIC_SIMILARITY_THRESHOLD = 0.86;
const RELATIONSHIP_CONFIDENCE_THRESHOLD = 0.75;

const fillerMessages = new Set([
  "hello",
  "hi",
  "hey",
  "okay",
  "ok",
  "thanks",
  "thank you",
  "yes",
  "no",
  "cool",
  "great",
  "got it",
]);

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:password|passwd|pwd|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret)\b\s*(?:is|=|:)\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];

export interface ExplicitMemoryResult {
  readonly stored: readonly MemoryRecord[];
  readonly duplicateCount: number;
  readonly rejectedCount: number;
  readonly extractedCount: number;
}

export class MemoryService {
  constructor(
    private readonly repository: MemoryRepositoryPort,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly extractor: MemoryExtractionEngine,
  ) {}

  async rememberInteraction(
    input: RememberInteractionInput,
  ): Promise<readonly MemoryRecord[]> {
    return (
      await this.processInteraction(
        input,
        isExplicitMemoryRequest(input.userMessage.content),
      )
    ).stored;
  }

  async rememberExplicitInteraction(
    input: RememberInteractionInput,
  ): Promise<ExplicitMemoryResult> {
    return this.processInteraction(input, true);
  }

  private async processInteraction(
    input: RememberInteractionInput,
    explicitRequest: boolean,
  ): Promise<ExplicitMemoryResult> {
    if (
      isFillerMessage(input.userMessage.content) ||
      containsSecret(input.userMessage.content)
    ) {
      return {
        stored: [],
        duplicateCount: 0,
        rejectedCount: 1,
        extractedCount: 0,
      };
    }

    const extracted = await this.extractor.extract({
      userMessage: input.userMessage.content,
      assistantResponse: input.assistantResponse,
      recentMessages: input.recentMessages,
      explicitRequest,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const stored: MemoryRecord[] = [];
    let duplicateCount = 0;
    let rejectedCount = 0;

    for (const extractedMemory of extracted) {
      if (
        isFillerMessage(extractedMemory.content) ||
        containsSecret(extractedMemory.content)
      ) {
        rejectedCount += 1;
        continue;
      }

      const candidate = explicitRequest
        ? {
            ...extractedMemory,
            importance: Math.max(extractedMemory.importance, 0.85),
            metadata: {
              ...extractedMemory.metadata,
              explicitMemoryRequest: true,
            },
          }
        : extractedMemory;
      const embedding = await this.embeddingProvider.embed(
        input.signal
          ? { text: candidate.content, signal: input.signal }
          : { text: candidate.content },
      );
      const supersedesId =
        candidate.memoryType === "semantic"
          ? await this.findSupersededMemory(
              input.userId,
              candidate,
              embedding,
              input.signal,
            )
          : undefined;

      if (supersedesId === "duplicate") {
        duplicateCount += 1;
        continue;
      }

      stored.push(
        await this.repository.saveMemory(
          {
            userId: input.userId,
            memoryType: candidate.memoryType,
            semanticType: candidate.semanticType,
            content: candidate.content,
            importance: candidate.importance,
            confidence: candidate.confidence,
            occurredAt: candidate.occurredAt,
            validFrom: candidate.validFrom,
            validUntil: candidate.validUntil,
            sourceConversationId: input.conversationId,
            sourceMessageId: input.userMessage.id,
            embedding,
            metadata: candidate.metadata,
          },
          supersedesId,
        ),
      );
    }

    return {
      stored,
      duplicateCount,
      rejectedCount,
      extractedCount: extracted.length,
    };
  }

  private async findSupersededMemory(
    userId: string,
    candidate: ExtractedMemory,
    embedding: readonly number[],
    signal?: AbortSignal,
  ): Promise<string | "duplicate" | undefined> {
    const similar = await this.repository.findSimilarSemanticMemories(
      userId,
      embedding,
      SEMANTIC_SIMILARITY_THRESHOLD,
      3,
    );
    const existing = similar[0];
    if (!existing) {
      return undefined;
    }

    const relationship = await this.extractor.classifyRelationship(
      existing,
      candidate,
      signal,
    );
    return relationshipAction(existing.id, relationship);
  }
}

function relationshipAction(
  existingMemoryId: string,
  relationship: MemoryRelationshipResult,
): string | "duplicate" | undefined {
  if (relationship.confidence < RELATIONSHIP_CONFIDENCE_THRESHOLD) {
    return undefined;
  }

  switch (relationship.relationship) {
    case "duplicate":
      return "duplicate";
    case "update":
    case "contradiction":
      return existingMemoryId;
    case "unrelated":
      return undefined;
  }
}

export function isFillerMessage(message: string): boolean {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  return fillerMessages.has(normalized);
}

export function isExplicitMemoryRequest(message: string): boolean {
  return /^\s*(?:please\s+)?(?:remember(?:\s+that)?|don't\s+forget(?:\s+that)?)\b/i.test(
    message,
  );
}

export function containsSecret(message: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(message));
}

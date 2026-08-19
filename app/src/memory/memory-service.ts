import type { EmbeddingProvider } from "../brain/embedding-provider.js";
import type {
  ExtractedMemory,
  MemoryExtractionEngine,
  MemoryRecord,
  MemoryRelationshipResult,
  MemoryRepositoryPort,
  RememberInteractionInput,
} from "./types.js";

const SEMANTIC_SIMILARITY_THRESHOLD = 0.72;
const SEMANTIC_RECONCILIATION_LIMIT = 10;
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
      const reconciliation =
        candidate.memoryType === "semantic" && candidate.semanticType
          ? await this.reconcileSemanticMemory(
              input.userId,
              candidate,
              embedding,
              input.signal,
            )
          : undefined;

      if (reconciliation === "duplicate") {
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
          reconciliation,
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

  private async reconcileSemanticMemory(
    userId: string,
    candidate: ExtractedMemory,
    embedding: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly string[] | "duplicate"> {
    if (!candidate.semanticType) {
      return [];
    }

    const similar = await this.repository.findSimilarSemanticMemories(
      userId,
      candidate.semanticType,
      embedding,
      SEMANTIC_SIMILARITY_THRESHOLD,
      SEMANTIC_RECONCILIATION_LIMIT,
    );
    const duplicateIds: string[] = [];
    const conflictingIds: string[] = [];

    for (const existing of similar) {
      const relationship = await this.extractor.classifyRelationship(
        existing,
        candidate,
        signal,
      );
      const action = relationshipAction(existing.id, relationship);
      if (action === "duplicate") {
        duplicateIds.push(existing.id);
      } else if (action) {
        conflictingIds.push(action);
      }
    }

    if (duplicateIds.length === 1 && conflictingIds.length === 0) {
      return "duplicate";
    }

    return [...new Set([...duplicateIds, ...conflictingIds])];
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

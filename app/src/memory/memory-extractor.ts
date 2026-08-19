import { z } from "zod";

import type { AIProvider, ChatInput } from "../brain/ai-provider.js";
import type {
  ExtractedMemory,
  MemoryExtractionEngine,
  MemoryExtractionInput,
  MemoryRecord,
  MemoryRelationshipResult,
} from "./types.js";

const extractionSystemPrompt = `You evaluate only information supplied by the user for Shiva's long-term memory.

Return valid JSON only with this shape:
{"memories":[...]}

Store durable, useful episodic events or semantic knowledge. Give explicit requests such as "remember that" strong priority, treating the user's entire meaningful statement as memory input while storing the underlying meanings rather than the command.

Produce multiple atomic memories when one statement contains multiple materially useful meanings. Preserve every independent relationship, preference, fact, profile detail, project fact, event, or decision. Do not discard one meaning merely because another meaning was extracted. Each memory should express one useful proposition while retaining names and context needed to understand it independently.

Example: "Remember that I love travelling with my Wife Charmi" contains at least two semantic memories:
- relationship: "Charmi is Yash's wife."
- preference: "Yash loves travelling with his wife Charmi."

Ignore greetings, filler, acknowledgements, transient small talk, model-generated claims, and credentials or authentication secrets.

Memory types:
- episodic: something that happened or a decision/event, with semanticType null
- semantic: a durable fact, preference, relationship, project_fact, or profile item

Each remembered item must contain shouldRemember=true, memoryType, semanticType, content, importance (0..1), confidence (0..1), and optional ISO timestamps occurredAt, validFrom, validUntil. Return {"memories":[]} when nothing should be stored.`;

const explicitCoverageSystemPrompt = `Audit an explicit memory request for omitted durable meanings.

You receive the full meaningful user statement and memories already extracted from it. Return valid JSON only as {"memories":[...]}.

Each new item must contain shouldRemember=true, memoryType (episodic or semantic), semanticType (null for episodic; fact, preference, relationship, project_fact, or profile for semantic), content, importance (0..1), confidence (0..1), and optional ISO timestamps occurredAt, validFrom, and validUntil.

Split compound statements into atomic memories. Return every materially useful relationship, preference, fact, profile detail, project fact, event, or decision that is NOT already represented. Preserve names and context. Do not repeat or paraphrase an existing extracted memory. Return {"memories":[]} only when all useful meanings are already covered.

For "Remember that I love travelling with my Wife Charmi", coverage requires both the relationship that Charmi is Yash's wife and the preference that Yash loves travelling with his wife Charmi.`;

const relationshipSystemPrompt = `Classify the relationship between an active semantic memory and a proposed new semantic memory.

Return valid JSON only:
{"relationship":"duplicate|update|contradiction|unrelated","confidence":0.0}

Use duplicate when they mean the same thing. Use update when the new memory refines or replaces the old information. Use contradiction when both cannot currently be true. Use unrelated when uncertain or about different subjects.`;

const rememberedMemorySchema = z
  .object({
    shouldRemember: z.literal(true),
    memoryType: z.enum(["episodic", "semantic"]),
    semanticType: z
      .enum(["fact", "preference", "relationship", "project_fact", "profile"])
      .nullable()
      .optional(),
    content: z.string().trim().min(1).max(4_000),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    validFrom: z.string().datetime({ offset: true }).nullable().optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((memory, context) => {
    if (memory.memoryType === "semantic" && !memory.semanticType) {
      context.addIssue({
        code: "custom",
        path: ["semanticType"],
        message: "semantic memories require semanticType",
      });
    }

    if (memory.memoryType === "episodic" && memory.semanticType) {
      context.addIssue({
        code: "custom",
        path: ["semanticType"],
        message: "episodic memories must use a null semanticType",
      });
    }
  });

const ignoredMemorySchema = z.object({
  shouldRemember: z.literal(false),
});

const extractionResponseSchema = z.object({
  memories: z
    .array(z.union([rememberedMemorySchema, ignoredMemorySchema]))
    .max(10),
});

const relationshipResponseSchema = z.object({
  relationship: z.enum([
    "duplicate",
    "update",
    "contradiction",
    "unrelated",
  ]),
  confidence: z.number().min(0).max(1),
});

export class MemoryExtractionError extends Error {
  override readonly name = "MemoryExtractionError";
}

export class MemoryExtractor implements MemoryExtractionEngine {
  constructor(private readonly provider: AIProvider) {}

  async extract(
    input: MemoryExtractionInput,
  ): Promise<readonly ExtractedMemory[]> {
    const recentContext = input.recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const initiallyExtracted = await this.extractWithPrompt(
      extractionSystemPrompt,
      {
        explicitMemoryRequest: input.explicitRequest ?? false,
        recentConversation: recentContext,
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
      },
      input.signal,
    );

    if (!input.explicitRequest) {
      return initiallyExtracted;
    }

    const missingMemories = await this.extractWithPrompt(
      explicitCoverageSystemPrompt,
      {
        explicitMemoryRequest: true,
        fullUserStatement: input.userMessage,
        alreadyExtractedMemories: initiallyExtracted,
      },
      input.signal,
    );

    return deduplicateMemories([...initiallyExtracted, ...missingMemories]);
  }

  private async extractWithPrompt(
    systemPrompt: string,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<readonly ExtractedMemory[]> {
    const result = await this.provider.chat(
      withOptionalSignal(
        {
          responseFormat: "json",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(payload) },
          ],
        },
        signal,
      ),
    );
    const parsed = parseJson(result.content, extractionResponseSchema);

    return parsed.memories
      .filter((memory): memory is z.infer<typeof rememberedMemorySchema> =>
        memory.shouldRemember,
      )
      .map((memory) => ({
        memoryType: memory.memoryType,
        semanticType:
          memory.memoryType === "semantic" ? (memory.semanticType ?? null) : null,
        content: memory.content,
        importance: memory.importance,
        confidence: memory.confidence,
        occurredAt: parseDate(memory.occurredAt),
        validFrom: parseDate(memory.validFrom),
        validUntil: parseDate(memory.validUntil),
        metadata: memory.metadata ?? {},
      }));
  }

  async classifyRelationship(
    existing: MemoryRecord,
    candidate: ExtractedMemory,
    signal?: AbortSignal,
  ): Promise<MemoryRelationshipResult> {
    const result = await this.provider.chat(
      withOptionalSignal(
        {
          responseFormat: "json",
          messages: [
            { role: "system", content: relationshipSystemPrompt },
            {
              role: "user",
              content: JSON.stringify({
                activeMemory: {
                  semanticType: existing.semanticType,
                  content: existing.content,
                },
                proposedMemory: {
                  semanticType: candidate.semanticType,
                  content: candidate.content,
                },
              }),
            },
          ],
        },
        signal,
      ),
    );

    return parseJson(result.content, relationshipResponseSchema);
  }
}

function withOptionalSignal(input: ChatInput, signal?: AbortSignal): ChatInput {
  return signal ? { ...input, signal } : input;
}

function parseJson<T>(content: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new MemoryExtractionError("The model returned malformed memory JSON.");
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MemoryExtractionError(
      "The model returned memory JSON with an invalid shape.",
    );
  }
  return parsed.data;
}

function parseDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function deduplicateMemories(
  memories: readonly ExtractedMemory[],
): readonly ExtractedMemory[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = [
      memory.memoryType,
      memory.semanticType ?? "",
      memory.content.trim().toLocaleLowerCase("en-US"),
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

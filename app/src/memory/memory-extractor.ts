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

Store durable, useful episodic events or semantic knowledge. Give explicit requests such as "remember that" strong priority, but store the underlying fact rather than the command. Ignore greetings, filler, acknowledgements, transient small talk, model-generated claims, and credentials or authentication secrets.

Memory types:
- episodic: something that happened or a decision/event, with semanticType null
- semantic: a durable fact, preference, relationship, project_fact, or profile item

Each remembered item must contain shouldRemember=true, memoryType, semanticType, content, importance (0..1), confidence (0..1), and optional ISO timestamps occurredAt, validFrom, validUntil. Return {"memories":[]} when nothing should be stored.`;

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
    const result = await this.provider.chat(
      withOptionalSignal(
        {
          responseFormat: "json",
          messages: [
            { role: "system", content: extractionSystemPrompt },
            {
              role: "user",
              content: JSON.stringify({
                recentConversation: recentContext,
                userMessage: input.userMessage,
                assistantResponse: input.assistantResponse,
              }),
            },
          ],
        },
        input.signal,
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

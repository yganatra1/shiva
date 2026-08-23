import { z } from "zod";

import type { AIProvider, ChatInput } from "../brain/ai-provider";
import type {
  ExtractedMemory,
  MemoryExtractionEngine,
  MemoryExtractionInput,
  MemoryRecord,
  MemoryRelationshipResult,
} from "./types";

const temporalOutputGuidance = `Only include occurredAt, validFrom, or validUntil when the user supplied a fully resolved instant. Use an RFC 3339 timestamp with Z or an explicit UTC offset (for example, 2026-08-19T08:30:00Z). If only a calendar date or relative time is known, preserve that wording in content and omit the temporal field. Never use date-only, timezone-less, relative, empty, or placeholder timestamp values.`;

const extractionSystemPrompt = `You evaluate only information supplied by the user for Shiva's long-term memory.

Persistence acknowledgment invariant: Never claim information has been stored or will be remembered unless the memory subsystem confirms persistence.

Return valid JSON only with this shape:
{"memories":[...]}

Store durable, useful episodic events or semantic knowledge. Give explicit requests such as "remember that" strong priority, treating the user's entire meaningful statement as memory input while storing the underlying meanings rather than the command.

Produce multiple atomic memories when one statement contains multiple materially useful meanings. Preserve every independent relationship, preference, fact, profile detail, project fact, event, or decision. Do not discard one meaning merely because another meaning was extracted. Each memory should express one useful proposition while retaining names and context needed to understand it independently.

Example: "Remember that I love travelling with my Wife Charmi" contains at least two semantic memories:
- relationship: "Charmi is Yash's wife."
- preference: "Yash loves travelling with his wife Charmi."

Ignore greetings, filler, acknowledgements, transient small talk, model-generated claims, and credentials or authentication secrets.

Treat correction language such as "now", "actually", "instead", "no longer", and "only" as a change to the user's current state. Extract the new current meaning only. Do not merge an older value from recent conversation or assistant text into the new memory unless the user explicitly says both values remain true. For example, "Actually, my favourite colour is only blue" means one current blue preference, not "blue and black".

Memory types:
- episodic: something that happened or a decision/event, with semanticType "none"
- semantic: a durable fact, preference, relationship, project_fact, or profile item

Each remembered item must contain shouldRemember=true, memoryType, semanticType, content, importance (0..1), and confidence (0..1). ${temporalOutputGuidance} Return {"memories":[]} when nothing should be stored.`;

const explicitCoverageSystemPrompt = `Audit an explicit memory request for omitted durable meanings.

You receive the full meaningful user statement and memories already extracted from it. Return valid JSON only as {"memories":[...]}.

Each new item must contain shouldRemember=true, memoryType (episodic or semantic), semanticType ("none" for episodic; fact, preference, relationship, project_fact, or profile for semantic), content, importance (0..1), and confidence (0..1). ${temporalOutputGuidance}

Split compound statements into atomic memories. Return every materially useful relationship, preference, fact, profile detail, project fact, event, or decision that is NOT already represented. Preserve names and context. Do not repeat or paraphrase an existing extracted memory. Return {"memories":[]} only when all useful meanings are already covered.

For "Remember that I love travelling with my Wife Charmi", coverage requires both the relationship that Charmi is Yash's wife and the preference that Yash loves travelling with his wife Charmi.`;

const correctionAuditSystemPrompt = `Normalize a user correction into the complete authoritative set of current memories.

Return valid JSON only as {"memories":[...]}. Each item uses the standard memory fields: shouldRemember=true, memoryType, semanticType, content, importance, and confidence. ${temporalOutputGuidance}

The current user statement is authoritative. Prior conversation and the initial extraction may resolve references, but they must not contribute an older value that the user is replacing. Words such as "now", "actually", "instead", "no longer", and "only" signal replacement or exclusivity.

Return the complete corrected memory set for all durable meanings in the current statement. Do not return obsolete or merged alternatives. For "Now I am thinking my favourite color is Blue Actually only Blue", return one current blue preference and never a combined "blue and black" preference. Return {"memories":[]} only if the statement has no durable current meaning.`;

const relationshipSystemPrompt = `Classify the relationship between an active semantic memory and a proposed new semantic memory.

Return valid JSON only:
{"relationship":"duplicate|update|contradiction|unrelated","confidence":0.0}

Use duplicate when they mean the same thing. Use update when the new memory refines or replaces the old information. Use contradiction when both cannot currently be true. Use unrelated when uncertain or about different subjects.

Judge the underlying subject and attribute, not spelling or phrasing. "Favorite" and "favourite" are equivalent. A new exclusive value expressed with words such as "only", "now", "actually", "instead", or "no longer" replaces prior alternatives for the same attribute. For example, "favourite colour is only blue" contradicts both "favourite colour is black" and "favourite colours are blue and black".`;

const rfc3339TimestampSchema = z.string().datetime({ offset: true });

const commonMemoryShape = {
  shouldRemember: z.literal(true),
  content: z.string().trim().min(1).max(4_000),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  occurredAt: optionalTimestampSchema(),
  validFrom: optionalTimestampSchema(),
  validUntil: optionalTimestampSchema(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

const rememberedMemorySchema = z.discriminatedUnion("memoryType", [
  z.object({
    ...commonMemoryShape,
    memoryType: z.literal("episodic"),
    semanticType: z.literal("none"),
  }),
  z.object({
    ...commonMemoryShape,
    memoryType: z.literal("semantic"),
    semanticType: z.enum([
      "fact",
      "preference",
      "relationship",
      "project_fact",
      "profile",
    ]),
  }),
]);

export const MAX_EXTRACTED_MEMORIES = 20;

/**
 * The envelope is validated strictly, the items are not.
 *
 * A local model occasionally mislabels or overproduces one entry, and losing an
 * entire turn's memories because of a single bad field is far worse than
 * dropping that entry. Items are therefore repaired and filtered individually.
 */
const extractionEnvelopeSchema = z.object({
  memories: z.array(z.unknown()),
});

type RememberedMemory = z.infer<typeof rememberedMemorySchema>;

const relationshipResponseSchema = z.object({
  relationship: z.enum([
    "duplicate",
    "update",
    "contradiction",
    "unrelated",
  ]),
  confidence: z.number().min(0).max(1),
});

const extractionResponseFormat = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      maxItems: MAX_EXTRACTED_MEMORIES,
      items: {
        type: "object",
        properties: {
          shouldRemember: { type: "boolean", enum: [true] },
          memoryType: { type: "string", enum: ["episodic", "semantic"] },
          semanticType: {
            type: "string",
            enum: [
              "none",
              "fact",
              "preference",
              "relationship",
              "project_fact",
              "profile",
            ],
          },
          content: { type: "string" },
          importance: { type: "number" },
          confidence: { type: "number" },
          occurredAt: {
            type: "string",
            description:
              "RFC 3339 timestamp with Z or UTC offset; omit when unresolved",
          },
          validFrom: {
            type: "string",
            description:
              "RFC 3339 timestamp with Z or UTC offset; omit when unresolved",
          },
          validUntil: {
            type: "string",
            description:
              "RFC 3339 timestamp with Z or UTC offset; omit when unresolved",
          },
        },
        required: [
          "shouldRemember",
          "memoryType",
          "semanticType",
          "content",
          "importance",
          "confidence",
        ],
      },
    },
  },
  required: ["memories"],
} as const;

const relationshipResponseFormat = {
  type: "object",
  properties: {
    relationship: {
      type: "string",
      enum: ["duplicate", "update", "contradiction", "unrelated"],
    },
    confidence: { type: "number" },
  },
  required: ["relationship", "confidence"],
} as const;

export class MemoryExtractionError extends Error {
  override readonly name = "MemoryExtractionError";
}

export type MemoryExtractionWarning = (
  detail: Readonly<Record<string, unknown>>,
  message: string,
) => void;

export class MemoryExtractor implements MemoryExtractionEngine {
  constructor(
    private readonly provider: AIProvider,
    private readonly onWarning: MemoryExtractionWarning = () => {},
  ) {}

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

    let extracted = initiallyExtracted;

    if (input.explicitRequest) {
      const missingMemories = await this.extractWithPrompt(
        explicitCoverageSystemPrompt,
        {
          explicitMemoryRequest: true,
          fullUserStatement: input.userMessage,
          alreadyExtractedMemories: extracted,
        },
        input.signal,
      );
      extracted = deduplicateMemories([...extracted, ...missingMemories]);
    }

    if (isCorrectionStatement(input.userMessage)) {
      const correctedMemories = await this.extractWithPrompt(
        correctionAuditSystemPrompt,
        {
          fullUserStatement: input.userMessage,
          initiallyExtractedMemories: extracted,
        },
        input.signal,
      );
      if (correctedMemories.length > 0) {
        return deduplicateMemories(correctedMemories);
      }
    }

    return extracted;
  }

  private async extractWithPrompt(
    systemPrompt: string,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<readonly ExtractedMemory[]> {
    const result = await this.provider.chat(
      withOptionalSignal(
        {
          responseFormat: extractionResponseFormat,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(payload) },
          ],
        },
        signal,
      ),
    );
    const envelope = parseJson(result.content, extractionEnvelopeSchema);
    const accepted: RememberedMemory[] = [];
    let discarded = 0;
    for (const candidate of envelope.memories) {
      if (accepted.length >= MAX_EXTRACTED_MEMORIES) {
        discarded += 1;
        continue;
      }
      const memory = coerceRememberedMemory(candidate);
      if (memory) {
        accepted.push(memory);
      } else {
        discarded += 1;
      }
    }
    if (discarded > 0) {
      this.onWarning(
        { discarded, kept: accepted.length },
        "Discarded unusable extracted memories",
      );
    }

    return accepted.map((memory) => {
      const occurredAt = parseDate(memory.occurredAt);
      let validFrom = parseDate(memory.validFrom);
      let validUntil = parseDate(memory.validUntil);
      if (
        validFrom !== null &&
        validUntil !== null &&
        validUntil.getTime() < validFrom.getTime()
      ) {
        validFrom = null;
        validUntil = null;
      }

      return {
        memoryType: memory.memoryType,
        semanticType:
          memory.memoryType === "semantic" ? memory.semanticType : null,
        content: memory.content,
        importance: memory.importance,
        confidence: memory.confidence,
        occurredAt,
        validFrom,
        validUntil,
        metadata: memory.metadata ?? {},
      };
    });
  }

  async classifyRelationship(
    existing: MemoryRecord,
    candidate: ExtractedMemory,
    signal?: AbortSignal,
  ): Promise<MemoryRelationshipResult> {
    const result = await this.provider.chat(
      withOptionalSignal(
        {
          responseFormat: relationshipResponseFormat,
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

    const parsed = relationshipResponseSchema.safeParse(
      safeJsonValue(result.content),
    );
    if (parsed.success) {
      return parsed.data;
    }

    // "unrelated" is the documented uncertainty answer, so a malformed
    // classification stores the new memory instead of failing the whole turn.
    this.onWarning(
      { memoryId: existing.id },
      "Falling back to an unrelated memory classification",
    );
    return { relationship: "unrelated", confidence: 0 };
  }
}

/**
 * Accepts one model-produced memory, repairing the type/label mismatch the
 * local model makes most often. Returns null when the entry is unusable.
 */
function coerceRememberedMemory(value: unknown): RememberedMemory | null {
  const direct = rememberedMemorySchema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const repaired = rememberedMemorySchema.safeParse({
    ...record,
    semanticType: record.memoryType === "episodic" ? "none" : "fact",
  });
  return repaired.success ? repaired.data : null;
}

function withOptionalSignal(input: ChatInput, signal?: AbortSignal): ChatInput {
  return signal ? { ...input, signal } : input;
}

function safeJsonValue(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
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
    const issueSummary = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${formatIssuePath(issue.path)}:${issue.code}`)
      .join(", ");
    throw new MemoryExtractionError(
      `The model returned memory JSON with an invalid shape (${issueSummary}).`,
    );
  }
  return parsed.data;
}

function formatIssuePath(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "root";
}

function optionalTimestampSchema() {
  return z.preprocess(
    normalizeOptionalTimestamp,
    rfc3339TimestampSchema.nullable().optional(),
  ).catch(null);
}

function normalizeOptionalTimestamp(
  value: unknown,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const candidate = value.trim();
  if (!rfc3339TimestampSchema.safeParse(candidate).success) {
    return null;
  }
  const timestamp = new Date(candidate);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
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

function isCorrectionStatement(message: string): boolean {
  return /\b(?:now|actually|instead|no longer|only)\b/i.test(message);
}

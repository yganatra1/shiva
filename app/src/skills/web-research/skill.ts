import { z } from "zod";

import type { ShivaSkill, SkillResult } from "../types.js";
import type {
  WebOpenToolPort,
  WebSearchResult,
  WebSearchToolPort,
} from "../../tools/web/types.js";
import { WebToolError } from "../../tools/web/types.js";
import type {
  ResearchSource,
  WebResearchInput,
  WebResearchOutput,
} from "./types.js";

const searchQuerySchema = z
  .string()
  .trim()
  .min(2)
  .max(400)
  .refine((query) => query.split(/\s+/).length <= 50, {
    message: "Search queries may contain at most 50 words.",
  });
const inputSchema = z
  .object({
    query: searchQuerySchema,
    additionalQueries: z.array(searchQuerySchema).max(2).optional(),
    maxSources: z.number().int().min(1).max(6).default(4),
  })
  .strict();
const MAX_SOURCE_EVIDENCE_CHARACTERS = 6_000;
const MAX_TOTAL_EVIDENCE_CHARACTERS = 16_000;

export class WebResearchSkill
  implements ShivaSkill<WebResearchInput, WebResearchOutput>
{
  readonly name = "web_research";
  readonly description =
    "Searches current public web sources, opens selected results, and returns evidence with URLs for a grounded answer.";
  readonly inputDescription =
    '{ "query": "2-400 character search", "additionalQueries"?: [up to 2 alternate searches], "maxSources"?: 1-6 }';
  readonly inputSchema: z.ZodType<WebResearchInput> = inputSchema;
  readonly permissions = ["web.read"] as const;
  readonly configured: boolean;

  constructor(
    private readonly searchTool?: WebSearchToolPort,
    private readonly openTool?: WebOpenToolPort,
  ) {
    this.configured = searchTool !== undefined && openTool !== undefined;
  }

  async execute(
    input: WebResearchInput,
    context: Parameters<ShivaSkill<WebResearchInput, WebResearchOutput>["execute"]>[1],
  ): Promise<SkillResult<WebResearchOutput>> {
    if (!this.searchTool || !this.openTool) {
      return {
        success: false,
        error: {
          code: "WEB_RESEARCH_UNAVAILABLE",
          message: "Web research is not configured.",
        },
      };
    }
    const searchTool = this.searchTool;
    const queries = [...new Set([input.query, ...(input.additionalQueries ?? [])])];
    const resultSets = await Promise.all(
      queries.map((query) =>
        searchTool.search({
          query,
          count: 8,
          ...(context.signal ? { signal: context.signal } : {}),
        }),
      ),
    );
    const uniqueResults = deduplicateResults(resultSets.flat());
    const selected = uniqueResults.slice(0, input.maxSources ?? 4);
    const opened = await Promise.all(
      selected.map((result) => this.openSource(result, context.signal)),
    );
    const sources = limitEvidence(
      opened.filter((source): source is ResearchSource => source !== null),
    );

    if (sources.length === 0) {
      return {
        success: false,
        error: {
          code: "WEB_RESEARCH_EMPTY",
          message: "No usable public web sources were found.",
        },
      };
    }

    return {
      success: true,
      data: {
        query: input.query,
        searchedQueries: queries,
        sources,
      },
    };
  }

  private async openSource(
    result: WebSearchResult,
    signal?: AbortSignal,
  ): Promise<ResearchSource | null> {
    const openTool = this.openTool;
    if (!openTool) {
      return null;
    }
    try {
      const page = await openTool.open({
        url: result.url,
        ...(signal ? { signal } : {}),
      });
      const content = page.content
        .slice(0, MAX_SOURCE_EVIDENCE_CHARACTERS)
        .trim();
      return content.length > 0
        ? {
            title: page.title ?? result.title,
            url: page.url,
            content,
          }
        : null;
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      if (error instanceof WebToolError && error.failure === "BLOCKED_URL") {
        return null;
      }
      const fallback = result.description.slice(0, 2_000).trim();
      return fallback.length > 0
        ? { title: result.title, url: result.url, content: fallback }
        : null;
    }
  }
}

function limitEvidence(
  sources: readonly ResearchSource[],
): ResearchSource[] {
  const limited: ResearchSource[] = [];
  let remaining = MAX_TOTAL_EVIDENCE_CHARACTERS;
  for (const source of sources) {
    if (remaining <= 0) break;
    const content = source.content.slice(0, remaining).trim();
    if (content.length === 0) continue;
    limited.push({ ...source, content });
    remaining -= content.length;
  }
  return limited;
}

function deduplicateResults(
  results: readonly WebSearchResult[],
): WebSearchResult[] {
  const seen = new Set<string>();
  const unique: WebSearchResult[] = [];
  for (const result of results) {
    let key: string;
    try {
      const url = new URL(result.url);
      url.hash = "";
      key = url.toString();
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }
  return unique;
}

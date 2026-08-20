export interface WebResearchInput {
  readonly query: string;
  readonly additionalQueries?: readonly string[] | undefined;
  readonly maxSources?: number | undefined;
}

export interface ResearchSource {
  readonly title: string;
  readonly url: string;
  readonly content: string;
}

export interface WebResearchOutput {
  readonly query: string;
  readonly searchedQueries: readonly string[];
  readonly sources: readonly ResearchSource[];
}

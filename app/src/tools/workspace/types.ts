export interface WorkspaceDocument {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface WorkspaceMatch {
  readonly path: string;
  readonly line: number;
  readonly excerpt: string;
}

export interface WorkspaceOverview {
  readonly workspace: "shiva";
  readonly files: readonly string[];
  readonly documents: readonly WorkspaceDocument[];
  readonly matches: readonly WorkspaceMatch[];
  readonly truncated: boolean;
}

export interface WorkspaceAnalysis {
  readonly workspace: "shiva";
  readonly question: string;
  readonly files: readonly string[];
  readonly documents: readonly WorkspaceDocument[];
  readonly matches: readonly WorkspaceMatch[];
  readonly truncated: boolean;
}

export interface WorkspaceAnalysisInput {
  readonly question: string;
  readonly paths?: readonly string[];
  readonly searchTerms?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface WorkspaceReaderPort {
  overview(focus?: string, signal?: AbortSignal): Promise<WorkspaceOverview>;
  analyze(input: WorkspaceAnalysisInput): Promise<WorkspaceAnalysis>;
}

/** One autonomous agent process shiva-api can delegate a self-contained goal to. */
export interface AgentDescriptor {
  readonly name: string;
  readonly description: string;
  /** e.g. http://127.0.0.1:3002 — no trailing slash or path. */
  readonly baseUrl: string;
}

export interface AgentDelegationResult {
  readonly success: boolean;
  readonly summary: string;
  readonly steps?: number;
}

/** One independently managed agent process Shiva Core can delegate work to. */
export interface AgentDescriptor {
  /** Stable transport/routing identifier, for example `device-agent`. */
  readonly id: string;
  /** Human-readable display name, for example `Device Agent`. */
  readonly name: string;
  readonly description: string;
  /** Free-form, human-readable statements used by Core for agent selection. */
  readonly capabilities: readonly string[];
  /**
   * @deprecated Temporary compatibility for the synchronous HTTP transport.
   * Redis-routed Core code must select and address agents by `id` instead.
   */
  readonly baseUrl?: string;
}

/**
 * Compatibility input for the pre-Redis runtime, where `name` was both the
 * route key and display label. Registry reads always return AgentDescriptor.
 */
export interface LegacyAgentDescriptor {
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
}

export type AgentRegistration = AgentDescriptor | LegacyAgentDescriptor;

export interface AgentDelegationResult {
  readonly success: boolean;
  readonly summary: string;
  readonly steps?: number;
}

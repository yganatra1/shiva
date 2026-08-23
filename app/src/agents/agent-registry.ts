import type { AgentDescriptor } from "./types";

export class DuplicateAgentError extends Error {
  override readonly name = "DuplicateAgentError";
}

export class UnknownAgentError extends Error {
  override readonly name = "UnknownAgentError";
}

/**
 * The registry of autonomous agent processes shiva-api can delegate to.
 * Mirrors PackRegistry (app/src/skills/pack-registry.ts) deliberately: this
 * is the same "small catalog, discovery only" shape, just one level up —
 * adding a second agent later is one register() call here, not new core code.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDescriptor>();

  register(agent: AgentDescriptor): void {
    if (this.agents.has(agent.name)) {
      throw new DuplicateAgentError(`Agent '${agent.name}' is already registered.`);
    }
    this.agents.set(agent.name, agent);
  }

  get(name: string): AgentDescriptor {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new UnknownAgentError(`Agent '${name}' is not registered.`);
    }
    return agent;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  list(): readonly AgentDescriptor[] {
    return [...this.agents.values()];
  }
}

import type {
  AgentDescriptor,
  AgentRegistration,
  LegacyAgentDescriptor,
} from "./types";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class InvalidAgentDefinitionError extends Error {
  override readonly name = "InvalidAgentDefinitionError";
}

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

  register(agent: AgentRegistration): void {
    const normalized = normalizeAgent(agent);
    if (this.agents.has(normalized.id)) {
      throw new DuplicateAgentError(
        `Agent '${normalized.id}' is already registered.`,
      );
    }
    this.agents.set(normalized.id, normalized);
  }

  get(id: string): AgentDescriptor {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new UnknownAgentError(`Agent '${id}' is not registered.`);
    }
    return agent;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  list(): readonly AgentDescriptor[] {
    return [...this.agents.values()];
  }
}

function normalizeAgent(agent: AgentRegistration): AgentDescriptor {
  if (isLegacyAgent(agent)) {
    return freezeAgent({
      id: requiredId(agent.name),
      name: requiredText(agent.name, "name"),
      description: requiredText(agent.description, "description"),
      capabilities: [],
      baseUrl: requiredText(agent.baseUrl, "baseUrl"),
    });
  }

  const capabilities = agent.capabilities.map((capability) =>
    requiredText(capability, "capability"),
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new InvalidAgentDefinitionError(
      "Agent capabilities must not contain duplicates.",
    );
  }

  return freezeAgent({
    id: requiredId(agent.id),
    name: requiredText(agent.name, "name"),
    description: requiredText(agent.description, "description"),
    capabilities,
    ...(agent.baseUrl
      ? { baseUrl: requiredText(agent.baseUrl, "baseUrl") }
      : {}),
  });
}

function isLegacyAgent(
  agent: AgentRegistration,
): agent is LegacyAgentDescriptor {
  return !("id" in agent);
}

function requiredId(value: string): string {
  const id = requiredText(value, "id");
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new InvalidAgentDefinitionError(
      "Agent IDs must be lowercase kebab-case identifiers.",
    );
  }
  return id;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidAgentDefinitionError(
      `Agent ${field} must not be empty.`,
    );
  }
  return normalized;
}

function freezeAgent(agent: AgentDescriptor): AgentDescriptor {
  return Object.freeze({
    ...agent,
    capabilities: Object.freeze([...agent.capabilities]),
  });
}

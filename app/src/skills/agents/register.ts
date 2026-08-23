import type { AgentClient } from "../../agents/agent-client";
import type { AgentRegistry } from "../../agents/agent-registry";
import type { SkillRegistry } from "../registry";
import { createDelegateToAgentSkill } from "../delegate-to-agent/skill";

export function registerAgentSkills(
  registry: SkillRegistry,
  agentClient: AgentClient,
  agentRegistry: AgentRegistry,
): void {
  registry.register(createDelegateToAgentSkill(agentClient, agentRegistry));
}

import type { AgentRegistry } from "../../agents/agent-registry";
import type { SkillRegistry } from "../registry";
import {
  createDelegateToAgentSkill,
  type AgentDelegator,
} from "../delegate-to-agent/skill";

export function registerAgentSkills(
  registry: SkillRegistry,
  agentClient: AgentDelegator,
  agentRegistry: AgentRegistry,
): void {
  registry.register(createDelegateToAgentSkill(agentClient, agentRegistry));
}

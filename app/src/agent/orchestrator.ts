import type { AgentLoop } from "./agent-loop.js";
import type {
  AgentOrchestratorPort,
  AgentRequest,
  AgentRunResult,
} from "./types.js";

export class ShivaOrchestrator implements AgentOrchestratorPort {
  constructor(private readonly loop: Pick<AgentLoop, "run">) {}

  run(request: AgentRequest): Promise<AgentRunResult> {
    const {
      allowedSkills: _ignoredAllowedSkills,
      ...unscopedRequest
    } = request;
    return this.loop.run(unscopedRequest);
  }
}

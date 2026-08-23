import type { AgentLoop } from "./agent-loop";
import type {
  AgentOrchestratorPort,
  AgentRequest,
  AgentRunResult,
} from "./types";

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

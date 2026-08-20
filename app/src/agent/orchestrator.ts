import type { AgentLoop } from "./agent-loop.js";
import type {
  AgentOrchestratorPort,
  AgentRequest,
  AgentRunResult,
} from "./types.js";

const EXPENSE_INTENT =
  /(?:\b(?:expense|expenses|spent|spend|paid|bought|purchase|purchased)\b|(?:₹|\bINR\b|\brupees?\b))/i;
const EXPENSE_WRITE_ACTION =
  /(?:\b(?:add|record|note|log|save)\b|\b(?:I|we)\s+(?:just\s+)?(?:spent|paid|bought|purchased)\b)/i;
const EXPENSE_READ_ACTION =
  /\b(?:show|list|what|how much|total|calculate|report|summari[sz]e)\b/i;
const WEB_INTENT =
  /\b(?:search(?: the)? web|web research|research|look up|find online|latest|current pricing|up[- ]to[- ]date)\b/i;

export class ShivaOrchestrator implements AgentOrchestratorPort {
  constructor(
    private readonly loop: Pick<AgentLoop, "run">,
    private readonly capabilities: {
      readonly expenses: boolean;
      readonly web: boolean;
    },
  ) {}

  shouldHandle(message: string): boolean {
    return this.requiredSkills(message).length > 0;
  }

  run(request: AgentRequest): Promise<AgentRunResult> {
    const requiredSkills = this.requiredSkills(request.userMessage);
    return this.loop.run({
      ...request,
      allowedSkills: requiredSkills,
      requiredSkills,
    });
  }

  private requiredSkills(message: string): string[] {
    const required: string[] = [];
    const expenseIntent =
      this.capabilities.expenses && EXPENSE_INTENT.test(message);
    if (expenseIntent && EXPENSE_WRITE_ACTION.test(message)) {
      required.push("record_expense");
    }
    if (expenseIntent && EXPENSE_READ_ACTION.test(message)) {
      required.push("expense_report");
    }
    if (this.capabilities.web && WEB_INTENT.test(message)) {
      required.push("web_research");
    }
    return required;
  }
}

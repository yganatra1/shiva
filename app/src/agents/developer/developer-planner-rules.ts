/**
 * Domain-specific planner rules for Developer Agent's single developer_execute
 * skill. Kept out of the shared agent/planner.ts so that file stays
 * domain-agnostic.
 */
export const DEVELOPER_AGENT_DOMAIN_RULES: readonly string[] = [
  "- Never include a request to push, deploy, restart, or reboot any service in the instruction sent to developer_execute unless the user's original request explicitly asked for that.",
  "- Keep each developer_execute instruction to one well-scoped task. A vague or open-ended instruction (e.g. \"improve the codebase\") produces an unbounded, hard-to-review session — return a grounded respond asking for a narrower task instead of guessing scope.",
  "- developer_execute's result is Claude Code's own report of what it did, not independently verified. Relay it to Core as that report, not as confirmed fact — never claim the requested change is correct beyond what the report itself says. If isError is true in the observation, the session did not complete the task; say so plainly.",
];

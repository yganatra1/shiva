import {
  ExecutionPolicyEngine,
  type ExecutionPolicyDecision,
  type ExecutionPolicyRequest,
} from "../../security/policy-engine";

/**
 * A specialized worker never conducts its own conversation or confirmation
 * workflow. Receiving a task on its agent-scoped Redis consumer group means
 * Shiva Core already selected the worker and applied the user-facing policy
 * to the exact delegated instruction. The worker still uses the normal
 * deterministic policy implementation, but evaluates calls inside that
 * already-authorized boundary as confirmed.
 */
export class CoreAuthorizedAgentExecutionPolicy extends ExecutionPolicyEngine {
  override evaluate(
    request: ExecutionPolicyRequest,
  ): Promise<ExecutionPolicyDecision> {
    return super.evaluate({
      ...request,
      userAuthorized: true,
      confirmed: true,
    });
  }
}

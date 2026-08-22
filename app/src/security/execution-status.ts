import type { ConfirmationService } from "./confirmation.js";
import type { ExecutionMode } from "./execution-mode.js";
import type { ExecutionStateService } from "./execution-state.js";

export interface ExecutionStatus {
  readonly executionMode: ExecutionMode;
  readonly maxExecutionMode: ExecutionMode;
  readonly effectiveExecutionMode: ExecutionMode;
  readonly lockdown: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly pendingConfirmation: {
    readonly id: string;
    readonly conversationId: string;
    readonly skill: string;
    readonly sanitizedArguments: unknown;
    readonly reason: string;
    readonly expiresAt: string;
  } | null;
}

export interface ExecutionStatusPort {
  getStatus(conversationId?: string): Promise<ExecutionStatus>;
}

export class ExecutionStatusService implements ExecutionStatusPort {
  constructor(
    private readonly state: ExecutionStateService,
    private readonly confirmations: ConfirmationService,
    private readonly userId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getStatus(conversationId?: string): Promise<ExecutionStatus> {
    const now = this.now();
    const [state, pending] = await Promise.all([
      this.state.getState(),
      this.confirmations.findPending(this.userId, conversationId, now),
    ]);
    return {
      executionMode: state.executionMode,
      maxExecutionMode: state.maxExecutionMode,
      effectiveExecutionMode: state.effectiveExecutionMode,
      lockdown: state.lockdown,
      updatedAt: state.updatedAt.toISOString(),
      updatedBy: state.updatedBy,
      pendingConfirmation: pending
        ? {
            id: pending.id,
            conversationId: pending.conversationId,
            skill: pending.skill,
            sanitizedArguments: pending.sanitizedArguments,
            reason: pending.reason,
            expiresAt: pending.expiresAt.toISOString(),
          }
        : null,
    };
  }
}

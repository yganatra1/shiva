import { z } from "zod";

import { executionModeSchema, type ExecutionState } from "../../security/execution-mode";
import type { ExecutionStateService } from "../../security/execution-state";
import type { ConfirmationService } from "../../security/confirmation";
import type { ShivaSkill, SkillResult } from "../types";

const emptyInputSchema = z.object({}).strict();
const setModeInputSchema = z
  .object({ mode: executionModeSchema })
  .strict();
const lockdownInputSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true) }).strict(),
  z
    .object({
      enabled: z.literal(false),
      executionMode: executionModeSchema.default("SAFE"),
    })
    .strict(),
]);

type EmptyInput = z.infer<typeof emptyInputSchema>;
type SetModeInput = z.infer<typeof setModeInputSchema>;
type LockdownInput = z.infer<typeof lockdownInputSchema>;

export class GetExecutionModeSkill
  implements ShivaSkill<EmptyInput, ExecutionState>
{
  readonly name = "get_execution_mode";
  readonly description =
    "Reads Shiva's stored, configured maximum, and effective execution modes plus lockdown state.";
  readonly inputDescription = "{}";
  readonly inputSchema: z.ZodType<EmptyInput> = emptyInputSchema;
  readonly pack = "execution_control";
  readonly execution = { mutability: "read", impact: "normal" } as const;
  readonly configured = true;

  constructor(private readonly state: ExecutionStateService) {}

  async execute(): Promise<SkillResult<ExecutionState>> {
    return { success: true, data: await this.state.getState() };
  }
}

export class SetExecutionModeSkill
  implements ShivaSkill<SetModeInput, ExecutionState>
{
  readonly name = "set_execution_mode";
  readonly description =
    "Changes Shiva's durable execution mode. Lowering authority is immediate; raising it is confirmed by the runtime and the host ceiling cannot be exceeded.";
  readonly inputDescription = '{ "mode": "SAFE|AUTO|FULL_ACCESS" }';
  readonly inputSchema: z.ZodType<SetModeInput> = setModeInputSchema;
  readonly pack = "execution_control";
  readonly execution = {
    mutability: "write",
    impact: "normal",
    control: "execution_mode",
  } as const;
  readonly configured = true;

  constructor(private readonly state: ExecutionStateService) {}

  async execute(
    input: SetModeInput,
    context: Parameters<ShivaSkill<SetModeInput, ExecutionState>["execute"]>[1],
  ): Promise<SkillResult<ExecutionState>> {
    return {
      success: true,
      data: await this.state.setExecutionMode(
        input.mode,
        context.userId,
        context.now(),
        requiredStateRevision(context.executionStateRevision),
      ),
    };
  }
}

export class SetLockdownSkill
  implements ShivaSkill<LockdownInput, ExecutionState>
{
  readonly name = "set_lockdown";
  readonly description =
    "Immediately enables emergency lockdown, or disables it after runtime confirmation and selects the post-lockdown mode.";
  readonly inputDescription =
    '{ "enabled": true } or { "enabled": false, "executionMode"?: "SAFE|AUTO|FULL_ACCESS" }';
  readonly inputSchema: z.ZodType<LockdownInput> = lockdownInputSchema;
  readonly pack = "execution_control";
  readonly execution = {
    mutability: "write",
    impact: "normal",
    control: "lockdown",
  } as const;
  readonly configured = true;

  constructor(
    private readonly state: ExecutionStateService,
    private readonly confirmations: ConfirmationService,
  ) {}

  async execute(
    input: LockdownInput,
    context: Parameters<ShivaSkill<LockdownInput, ExecutionState>["execute"]>[1],
  ): Promise<SkillResult<ExecutionState>> {
    if (input.enabled) {
      const now = context.now();
      const locked = await this.state.enableLockdown(
        context.userId,
        now,
        requiredStateRevision(context.executionStateRevision),
      );
      try {
        await this.confirmations.invalidatePending(now);
      } catch {
        // Lockdown itself is already effective. A stale approval still cannot
        // execute because confirmations bind the prior settings revision and
        // every control mutation uses compare-and-set persistence.
        context.reportAuditDiagnostic?.({
          category: "CONFIRMATION_INVALIDATION_FAILED",
          reason: "Lockdown succeeded, but pending confirmation cleanup failed.",
        });
      }
      return {
        success: true,
        data: locked,
      };
    }
    return {
      success: true,
      data: await this.state.disableLockdown(
        input.executionMode,
        context.userId,
        context.now(),
        requiredStateRevision(context.executionStateRevision),
      ),
    };
  }
}

function requiredStateRevision(revision: number | undefined): number {
  if (revision === undefined || !Number.isInteger(revision) || revision < 0) {
    throw new Error("The execution policy snapshot is unavailable.");
  }
  return revision;
}

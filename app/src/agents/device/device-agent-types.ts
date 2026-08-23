export type { DeviceCommandResult } from "./device-protocol";
import type { DeviceCommandResult } from "./device-protocol";

export interface DeviceAgentStep {
  readonly step: number;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly result: DeviceCommandResult;
}

export interface DeviceAgentGoalResult {
  readonly success: boolean;
  readonly summary: string;
  readonly steps: number;
}

export type DeviceAgentDecision =
  | {
      readonly type: "call_tool";
      readonly tool: string;
      readonly arguments: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "done";
      readonly success: boolean;
      readonly summary: string;
    };

export interface DeviceAgentPlanningContext {
  readonly goal: string;
  readonly steps: readonly DeviceAgentStep[];
  readonly stepNumber: number;
  readonly maxSteps: number;
  readonly correctionRequired?: string;
}

export interface DeviceAgentPlanner {
  decide(context: DeviceAgentPlanningContext): Promise<DeviceAgentDecision>;
}

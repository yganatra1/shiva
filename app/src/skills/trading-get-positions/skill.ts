import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { KiteClientPort, KitePosition } from "../../tools/kite/types";

const inputSchema = z.object({});

export type TradingGetPositionsInput = z.infer<typeof inputSchema>;
export interface TradingGetPositionsOutput {
  readonly net: readonly KitePosition[];
  readonly day: readonly KitePosition[];
}

/** Read-only: "what are my positions". Directly reads Kite's positions; not part of the deterministic scanner. */
export function createTradingGetPositionsSkill(client?: KiteClientPort) {
  return defineSkill<TradingGetPositionsInput, TradingGetPositionsOutput>({
    name: "trading_get_positions",
    description:
      "Returns the user's current net and day equity positions from their Kite account.",
    inputDescription: "{} (no input required)",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(): Promise<SkillResult<TradingGetPositionsOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "KITE_UNAVAILABLE",
            message: "Kite is not configured — set KITE_API_KEY/KITE_ACCESS_TOKEN.",
          },
        };
      }
      const positions = await client.getPositions();
      return { success: true, data: positions };
    },
  });
}

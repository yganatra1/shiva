import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import type { KiteClientPort, KiteOrder } from "../../tools/kite/types";

const inputSchema = z.object({});

export type TradingGetOrdersInput = z.infer<typeof inputSchema>;
export interface TradingGetOrdersOutput {
  readonly orders: readonly KiteOrder[];
}

/** Read-only: lists order statuses from Kite — useful for "did my order fill". */
export function createTradingGetOrdersSkill(client?: KiteClientPort) {
  return defineSkill<TradingGetOrdersInput, TradingGetOrdersOutput>({
    name: "trading_get_orders",
    description:
      "Returns the status of the user's orders placed today on their Kite account (e.g. to check whether a recently placed order has filled).",
    inputDescription: "{} (no input required)",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: client !== undefined,
    async execute(): Promise<SkillResult<TradingGetOrdersOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "KITE_UNAVAILABLE",
            message: "Kite is not configured — set KITE_API_KEY/KITE_ACCESS_TOKEN.",
          },
        };
      }
      const orders = await client.getOrders();
      return { success: true, data: { orders } };
    },
  });
}

import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import { KiteClientError, type KiteClientPort } from "../../tools/kite/types";

const inputSchema = z
  .object({
    orderId: z.string().trim().min(1).max(64),
    variety: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

export type TradingCancelOrderInput = z.infer<typeof inputSchema>;
export interface TradingCancelOrderOutput {
  readonly orderId: string;
  readonly cancelled: true;
}

/**
 * Cancels a real order on the user's Kite account — always executes live,
 * no simulation. Classified impact:"sensitive" for the same reason as
 * trading_place_order (cancelling can also have real consequences, e.g. an
 * unfilled protective order); Shiva's existing confirmation flow gates it.
 */
export function createTradingCancelOrderSkill(client?: KiteClientPort) {
  return defineSkill<TradingCancelOrderInput, TradingCancelOrderOutput>({
    name: "trading_cancel_order",
    description:
      "Cancels a pending order on the user's Kite account. This is a real, live action and requires the user's explicit confirmation before it is sent.",
    inputDescription: '{ "orderId": string, "variety"?: string }',
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "Cancelling a real order changes your live Kite account state.",
    },
    configured: client !== undefined,
    async execute(
      input: TradingCancelOrderInput,
    ): Promise<SkillResult<TradingCancelOrderOutput>> {
      if (!client) {
        return {
          success: false,
          error: {
            code: "KITE_UNAVAILABLE",
            message: "Kite is not configured — set KITE_API_KEY/KITE_ACCESS_TOKEN.",
          },
        };
      }
      try {
        await client.cancelOrder(input.orderId, input.variety);
        return { success: true, data: { orderId: input.orderId, cancelled: true } };
      } catch (error: unknown) {
        const message =
          error instanceof KiteClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Kite order cancellation failed.";
        return { success: false, error: { code: "KITE_CANCEL_FAILED", message } };
      }
    },
  });
}

import { z } from "zod";

import { defineSkill } from "../define-skill";
import type { SkillResult } from "../types";
import { KiteClientError, type KiteClientPort } from "../../tools/kite/types";
import type { TradingService } from "../../trading/trading-service";

const inputSchema = z
  .object({
    tradingsymbol: z.string().trim().min(1).max(64),
    exchange: z.string().trim().min(1).max(16).default("NSE"),
    transactionType: z.enum(["BUY", "SELL"]),
    quantity: z.number().int().positive(),
    orderType: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
    price: z.number().positive().optional(),
    product: z.enum(["CNC", "MIS", "NRML"]).default("CNC"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.orderType === "LIMIT" && value.price === undefined) {
      context.addIssue({
        code: "custom",
        path: ["price"],
        message: "price is required when orderType is LIMIT.",
      });
    }
  });

export type TradingPlaceOrderInput = z.infer<typeof inputSchema>;
export interface TradingPlaceOrderOutput {
  readonly orderId: string;
  readonly tradingsymbol: string;
  readonly transactionType: "BUY" | "SELL";
  readonly quantity: number;
  readonly orderType: "MARKET" | "LIMIT";
  readonly product: "CNC" | "MIS" | "NRML";
  readonly status: "submitted";
}

/**
 * Places a REAL equity order on the user's Kite account. There is no
 * paper/simulation mode — execute() always calls the real Kite endpoint.
 * Safety comes entirely from execution metadata below: impact:"sensitive"
 * routes this through Shiva's existing sensitive-action confirmation flow
 * (see the executor/policy engine), so the order is never sent until the
 * user has explicitly confirmed it. This skill builds no confirmation UI of
 * its own — it only declares the metadata and lets that existing mechanism
 * gate the call, exactly like developer_pm2_restart and other sensitive
 * skills already do.
 */
export function createTradingPlaceOrderSkill(
  client: KiteClientPort | undefined,
  tradingService: TradingService | undefined,
) {
  return defineSkill<TradingPlaceOrderInput, TradingPlaceOrderOutput>({
    name: "trading_place_order",
    description:
      "Places a real equity BUY/SELL order on the user's Kite account. This uses real money — it always executes live and requires the user's explicit confirmation before it is sent. No options/CE/PE, no short selling.",
    inputDescription:
      '{ "tradingsymbol": string, "exchange"?: string, "transactionType": "BUY"|"SELL", "quantity": positive int, "orderType"?: "MARKET"|"LIMIT", "price"?: number (required for LIMIT), "product"?: "CNC"|"MIS"|"NRML" }',
    inputSchema,
    execution: {
      mutability: "write",
      impact: "sensitive",
      confirmationReason: "Placing a real order will use real money on your Kite account.",
    },
    configured: client !== undefined && tradingService !== undefined,
    async execute(
      input: TradingPlaceOrderInput,
    ): Promise<SkillResult<TradingPlaceOrderOutput>> {
      if (!client || !tradingService) {
        return {
          success: false,
          error: {
            code: "KITE_UNAVAILABLE",
            message: "Kite is not configured — set KITE_API_KEY/KITE_ACCESS_TOKEN.",
          },
        };
      }
      try {
        const { orderId } = await client.placeOrder({
          tradingsymbol: input.tradingsymbol,
          exchange: input.exchange,
          transactionType: input.transactionType,
          orderType: input.orderType,
          quantity: input.quantity,
          product: input.product,
          ...(input.price !== undefined ? { price: input.price } : {}),
        });
        await tradingService.recordOrder({
          kiteOrderId: orderId,
          tradingsymbol: input.tradingsymbol,
          exchange: input.exchange,
          transactionType: input.transactionType,
          quantity: input.quantity,
          orderType: input.orderType,
          product: input.product,
          ...(input.price !== undefined ? { price: input.price } : {}),
          status: "submitted",
        });
        return {
          success: true,
          data: {
            orderId,
            tradingsymbol: input.tradingsymbol,
            transactionType: input.transactionType,
            quantity: input.quantity,
            orderType: input.orderType,
            product: input.product,
            status: "submitted",
          },
        };
      } catch (error: unknown) {
        const message =
          error instanceof KiteClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Kite order placement failed.";
        await tradingService.recordOrder({
          tradingsymbol: input.tradingsymbol,
          exchange: input.exchange,
          transactionType: input.transactionType,
          quantity: input.quantity,
          orderType: input.orderType,
          product: input.product,
          ...(input.price !== undefined ? { price: input.price } : {}),
          status: "failed",
          errorMessage: message,
        });
        return {
          success: false,
          error: { code: "KITE_ORDER_FAILED", message },
        };
      }
    },
  });
}

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { TradingService } from "../trading/trading-service";
import type { TradeOpportunity, TradingScanResult } from "../trading/types";
import { ApiError } from "./api-error";

const MAX_LIST_LIMIT = 200;

const listOpportunitiesQuerySchema = z
  .object({
    minScore: z.coerce.number().min(0).max(100).optional(),
    strategy: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  })
  .strict();
const symbolParamsSchema = z
  .object({ symbol: z.string().trim().min(1).max(64) })
  .strict();

export interface TradingRouteOptions {
  readonly service: TradingService;
  readonly token: string;
}

/**
 * Internal-only trading API, protected the same way as
 * /internal/scheduler/execute: a Bearer token compared with timingSafeEqual.
 * Registered from app.ts only when config.databaseUrl and
 * config.tradingApiToken are both present.
 */
export function registerTradingRoutes(
  app: FastifyInstance,
  options: TradingRouteOptions,
): void {
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/trading/")) return;
    if (!authorized(request.headers.authorization, options.token)) {
      throw new ApiError(
        401,
        "TRADING_UNAUTHORIZED",
        "Valid trading API authentication is required.",
      );
    }
  });

  app.post("/trading/scans", async (_request, reply) => {
    const result = await options.service.runScan();
    return noStore(reply).status(201).send({ scan: publicScan(result) });
  });

  app.get("/trading/scans/latest", async (_request, reply) => {
    const scan = await options.service.getLatestScan();
    if (!scan) {
      throw new ApiError(
        404,
        "TRADING_SCAN_NOT_FOUND",
        "No trading scan has been run yet.",
      );
    }
    return noStore(reply).send({ scan: publicScan(scan) });
  });

  app.get<{ Querystring: unknown }>(
    "/trading/opportunities",
    async (request, reply) => {
      const parsed = listOpportunitiesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "minScore, strategy, and limit are invalid.",
        );
      }
      const opportunities = await options.service.listOpportunities({
        ...(parsed.data.minScore !== undefined ? { minScore: parsed.data.minScore } : {}),
        ...(parsed.data.strategy !== undefined ? { strategy: parsed.data.strategy } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      return noStore(reply).send({
        opportunities: opportunities.map(publicOpportunity),
      });
    },
  );

  app.get<{ Params: unknown }>(
    "/trading/opportunities/:symbol",
    async (request, reply) => {
      const parsed = symbolParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        throw new ApiError(400, "INVALID_REQUEST", "A valid symbol is required.");
      }
      const opportunity = await options.service.getOpportunity(parsed.data.symbol);
      if (!opportunity) {
        throw new ApiError(
          404,
          "TRADING_OPPORTUNITY_NOT_FOUND",
          "No opportunity was found for that tradingsymbol in the latest scan.",
        );
      }
      return noStore(reply).send({ opportunity: publicOpportunity(opportunity) });
    },
  );
}

function publicScan(scan: TradingScanResult) {
  return {
    scanId: scan.scanId,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    benchmark: scan.benchmark,
    marketRegime: scan.marketRegime,
    totalInstruments: scan.totalInstruments,
    analyzedInstruments: scan.analyzedInstruments,
    skippedInstruments: scan.skippedInstruments,
    failedInstruments: scan.failedInstruments,
    opportunities: scan.opportunities.map(publicOpportunity),
    failures: scan.failures,
  };
}

function publicOpportunity(opportunity: TradeOpportunity) {
  return { ...opportunity };
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function noStore(reply: FastifyReply): FastifyReply {
  reply.header("cache-control", "no-store");
  return reply;
}

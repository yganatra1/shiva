import { z } from "zod";

import { defineSkill } from "../define-skill";

const inputSchema = z.object({}).strict();

const HEALTH_ENDPOINTS = {
  smartWhatsapp: "https://api.cysmartsolutions.com/health",
  smartSarthi: "https://api.cysmartsarthi.com/health",
} as const;

async function pingHealth(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (error: unknown) {
    return {
      status: "unreachable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getSentryUnresolvedIssues(): Promise<unknown> {
  const org = process.env.SENTRY_ORG;
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!org || !token) {
    return { status: "not_configured" };
  }
  const url = new URL(`https://sentry.io/api/0/organizations/${org}/issues/`);
  url.searchParams.set("statsPeriod", "24h");
  url.searchParams.set("query", "is:unresolved");
  url.searchParams.set("limit", "100");
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    return await response.json();
  } catch (error: unknown) {
    return {
      status: "unreachable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Hits Sentry (unresolved issues, org-wide) and every project's own /health endpoint. */
export async function checkSystemHealth(): Promise<unknown> {
  const [sentryIssues, smartWhatsapp, smartSarthi] = await Promise.all([
    getSentryUnresolvedIssues(),
    pingHealth(HEALTH_ENDPOINTS.smartWhatsapp),
    pingHealth(HEALTH_ENDPOINTS.smartSarthi),
  ]);
  return { sentryIssues, smartWhatsapp, smartSarthi };
}

export function createSystemHealthSkill() {
  return defineSkill({
    name: "system_health",
    description: "Checks system health across all projects.",
    inputDescription: "{}",
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute() {
      const data = await checkSystemHealth();
      return { success: true, data };
    },
  });
}

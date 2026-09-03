#!/usr/bin/env -S node --experimental-strip-types
/**
 * Manual, one-off helper: exchanges a Kite Connect `request_token` for a
 * daily `access_token`. Never run automatically by the app — Kite access
 * tokens expire daily and require an interactive browser login that this
 * script does NOT attempt to automate.
 *
 * Usage (see app/src/trading/README.md for the full walkthrough):
 *   1. Visit https://kite.trade/connect/login?api_key=<KITE_API_KEY>&v=3
 *      in a browser, log in, and let Kite redirect you back to your
 *      registered redirect URL with `?request_token=...` in the query string.
 *   2. Run:
 *        KITE_API_KEY=... KITE_API_SECRET=... \
 *        npx tsx scripts/kite-generate-session.ts <request_token>
 *   3. Set the printed access token as KITE_ACCESS_TOKEN for the
 *      trading-agent process (and shiva-api, if it also runs scans) and
 *      restart it. It must be regenerated every trading day.
 */
import { generateSession } from "../src/tools/kite/client.js";

async function main(): Promise<void> {
  const requestToken = process.argv[2];
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (!requestToken) {
    console.error("Usage: kite-generate-session.ts <request_token>");
    process.exitCode = 1;
    return;
  }
  if (!apiKey || !apiSecret) {
    console.error("KITE_API_KEY and KITE_API_SECRET must be set in the environment.");
    process.exitCode = 1;
    return;
  }

  const { accessToken } = await generateSession({
    apiKey,
    apiSecret,
    requestToken,
    ...(process.env.KITE_BASE_URL ? { baseUrl: process.env.KITE_BASE_URL } : {}),
  });
  console.info("KITE_ACCESS_TOKEN=" + accessToken);
}

void main().catch((error: unknown) => {
  console.error("kite-generate-session failed:", error);
  process.exitCode = 1;
});

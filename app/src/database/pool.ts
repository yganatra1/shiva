import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import type { AppConfig } from "../config/environment";
import * as schema from "./schema";

export type ShivaDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(config: AppConfig) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  });

  return {
    pool,
    db: drizzle(pool, { schema }),
  };
}

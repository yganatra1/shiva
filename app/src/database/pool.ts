import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export type ShivaDatabase = ReturnType<typeof createDatabase>["db"];

export interface DatabaseConnectionConfig {
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseSsl: boolean;
}

export function createDatabase(config: DatabaseConnectionConfig) {
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

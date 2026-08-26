import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";

import { ConfigurationError, loadConfig } from "../config/environment";
import { createDatabase } from "./pool";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

async function runMigrations(): Promise<void> {
  const config = loadConfig();
  const { db, pool } = createDatabase(config);

  try {
    await migrate(db, { migrationsFolder });
    console.info("Database migrations completed.");
  } finally {
    await pool.end();
  }
}

runMigrations().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
  } else {
    console.error("Database migration failed.", error);
  }
  process.exitCode = 1;
});

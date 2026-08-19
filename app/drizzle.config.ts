import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/database/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://shiva:change-me@127.0.0.1:5432/shiva",
  },
  strict: true,
  verbose: true,
});

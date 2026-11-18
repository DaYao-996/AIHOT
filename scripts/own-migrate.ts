// Migrate one local throwaway database. Refuses any other address. Does not seed.
import { assertThrowawayDatabase } from "../site/own-pipeline.ts";

assertThrowawayDatabase(process.env.DATABASE_URL ?? "");
const { REPO_ROOT } = await import("@aihot/backend/config");
const { closeDb, sql } = await import("@aihot/backend/db");
const { runMigrations } = await import("./migrate.ts");
try {
  const applied = await runMigrations(sql, REPO_ROOT, { backupWaitMs: 0 });
  console.log(JSON.stringify({ database: new URL(process.env.DATABASE_URL!).pathname, applied }));
} finally {
  await closeDb();
}

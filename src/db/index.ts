import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const dbDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "ollama-tiny-tasks.db");

// Use global singleton to prevent multiple connections during hot-reload / build
const globalForDb = globalThis as unknown as {
  _sqlite?: Database.Database;
  _migrated?: boolean;
};

if (!globalForDb._sqlite) {
  globalForDb._sqlite = new Database(dbPath);
  globalForDb._sqlite.pragma("journal_mode = WAL");
}

export const db = drizzle(globalForDb._sqlite, { schema });

// Run migrations once per process (creates tables on first run, safe to re-run)
if (!globalForDb._migrated) {
  try {
    migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } catch {
    // Tables may already exist on pre-migration installs - that's fine
  }
  globalForDb._migrated = true;

  // Startup sweep: reset any projects stuck in "running" state from a previous crash
  globalForDb._sqlite.exec(
    `UPDATE projects SET status = 'paused' WHERE status = 'running'`,
  );
  // Clear current_stage if the column exists (added in migration 0001).
  // Wrapped separately so it doesn't crash on pre-migration DBs.
  try {
    globalForDb._sqlite.exec(
      `UPDATE projects SET current_stage = NULL WHERE current_stage IS NOT NULL`,
    );
  } catch {
    // Column doesn't exist yet — migration will add it on next request
  }
  // Clear activity state (migration 0002)
  try {
    globalForDb._sqlite.exec(
      `UPDATE projects SET current_activity = NULL, stage_started_at = NULL WHERE current_activity IS NOT NULL OR stage_started_at IS NOT NULL`,
    );
  } catch {
    // Columns don't exist yet
  }
}

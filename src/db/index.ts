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
}

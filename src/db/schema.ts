import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  customInstructions: text("custom_instructions"),
  status: text("status", {
    enum: ["pending", "running", "paused", "review", "done"],
  })
    .notNull()
    .default("pending"),
  primaryModel: text("primary_model").notNull(),
  /** JSON array of file specs: [{ path, type, language, description }] */
  fileManifest: text("file_manifest"),
  completedStages: text("completed_stages").notNull().default("[]"),
  currentStage: text("current_stage"),
  /** Short human-readable text describing what the pipeline is doing right now */
  currentActivity: text("current_activity"),
  /** Counter incremented on every activity update — for "12 updates" UI */
  activityCounter: integer("activity_counter").notNull().default(0),
  /** Timestamp (ms) when current stage started — for elapsed time display */
  stageStartedAt: integer("stage_started_at"),
  /** JSON-serialised feedback progress ledger (see src/lib/ledger.ts) */
  feedbackLedger: text("feedback_ledger"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  parentId: integer("parent_id"), // self-ref for tree structure
  description: text("description").notNull(),
  status: text("status", {
    enum: [
      "awaiting_approval",
      "pending",
      "decomposing",
      "ready",
      "executing",
      "qa_check",
      "editing",
      "done",
      "stuck",
    ],
  })
    .notNull()
    .default("pending"),
  depth: integer("depth").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  filePath: text("file_path"), // target output file
  output: text("output"), // the produced result
  qAReason: text("qa_reason"), // last QA failure reason
  stuckReason: text("stuck_reason"),
  retryCount: integer("retry_count").notNull().default(0),
  editRetryCount: integer("edit_retry_count").notNull().default(0),
  parseRetryCount: integer("parse_retry_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Cross-file reference registry (system-managed, not LLM)
export const references = sqliteTable("references", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  filePath: text("file_path").notNull(),
  refType: text("ref_type", {
    enum: ["id", "class", "function", "variable", "endpoint"],
  }).notNull(),
  refName: text("ref_name").notNull(),
});

// Log entries for the SSE stream
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  taskId: integer("task_id"),
  agent: text("agent").notNull(),
  message: text("message").notNull(),
  rawPrompt: text("raw_prompt"), // full system + user prompt sent to LLM
  rawResponse: text("raw_response"), // raw LLM output before parsing
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Reference = typeof references.$inferSelect;
export type LogEntry = typeof logs.$inferSelect;

/** A single file in the project's output manifest */
export interface ManifestFile {
  path: string;
  type: "code" | "document" | "config" | "data";
  language: string; // e.g. "typescript", "python", "markdown", "json"
  description: string;
  /** Other manifest files this file imports from (architect-planned dep graph) */
  imports?: string[];
}

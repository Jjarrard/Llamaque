import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status", {
    enum: ["pending", "running", "paused", "done"],
  })
    .notNull()
    .default("pending"),
  primaryModel: text("primary_model").notNull().default("qwen3:1.7b"),
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

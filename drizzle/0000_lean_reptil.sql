CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`task_id` integer,
	`agent` text NOT NULL,
	`message` text NOT NULL,
	`raw_prompt` text,
	`raw_response` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`custom_instructions` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`primary_model` text DEFAULT 'qwen3:1.7b' NOT NULL,
	`file_manifest` text,
	`completed_stages` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_name` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`parent_id` integer,
	`description` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`file_path` text,
	`output` text,
	`qa_reason` text,
	`stuck_reason` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`edit_retry_count` integer DEFAULT 0 NOT NULL,
	`parse_retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

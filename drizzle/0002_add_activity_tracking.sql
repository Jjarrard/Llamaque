ALTER TABLE `projects` ADD COLUMN `current_activity` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `activity_counter` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `stage_started_at` integer;

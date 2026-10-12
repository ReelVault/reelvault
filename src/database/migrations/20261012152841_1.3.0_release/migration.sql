CREATE TABLE `interrupted_playback_sessions` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`media_file_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`played_seconds` integer NOT NULL,
	`furthest_position_seconds` integer NOT NULL,
	`duration_seconds` integer,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_interrupted_playback_sessions_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_interrupted_playback_sessions_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "interrupted_sessions_played_check" CHECK("played_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE `plugin_ui_overrides` (
	`plugin_id` text NOT NULL,
	`contribution_key` text NOT NULL,
	CONSTRAINT `plugin_ui_overrides_pk` PRIMARY KEY(`plugin_id`, `contribution_key`)
);
--> statement-breakpoint
CREATE TABLE `subtitle_provider_settings` (
	`provider_id` text PRIMARY KEY,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_history` (
	`id` text PRIMARY KEY,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`from_version` text,
	`to_version` text NOT NULL,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_update_history_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `playback_progress` ADD `dismissed_at` integer;--> statement-breakpoint
ALTER TABLE `scan_findings` ADD `ignored_at` integer;--> statement-breakpoint
ALTER TABLE `system_settings` ADD `last_modified_by` text;--> statement-breakpoint
CREATE INDEX `interrupted_sessions_profile_ended_idx` ON `interrupted_playback_sessions` (`profile_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `interrupted_sessions_media_idx` ON `interrupted_playback_sessions` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `interrupted_sessions_ended_idx` ON `interrupted_playback_sessions` (`ended_at`);--> statement-breakpoint
CREATE INDEX `update_history_started_idx` ON `update_history` (`started_at`);--> statement-breakpoint
CREATE INDEX `update_history_status_idx` ON `update_history` (`status`);
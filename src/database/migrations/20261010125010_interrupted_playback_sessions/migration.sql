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
CREATE INDEX `interrupted_sessions_profile_ended_idx` ON `interrupted_playback_sessions` (`profile_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `interrupted_sessions_media_idx` ON `interrupted_playback_sessions` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `interrupted_sessions_ended_idx` ON `interrupted_playback_sessions` (`ended_at`);
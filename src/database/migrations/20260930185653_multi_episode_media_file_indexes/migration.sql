DROP INDEX IF EXISTS `media_files_path_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_unique` ON `media_files` (`file_path`) WHERE "media_files"."episode_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_episode_unique` ON `media_files` (`file_path`,`episode_id`) WHERE "media_files"."episode_id" IS NOT NULL;

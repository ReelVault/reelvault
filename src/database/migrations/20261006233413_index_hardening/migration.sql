DROP INDEX IF EXISTS `media_files_path_unique`;--> statement-breakpoint
CREATE INDEX `downloads_media_file_created_idx` ON `downloads` (`media_file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_artifacts_plugin_created_idx` ON `media_artifacts` (`plugin_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_unlinked_unique` ON `media_files` (`file_path`) WHERE "media_files"."episode_id" IS NULL;--> statement-breakpoint
CREATE INDEX `media_files_library_id_idx` ON `media_files` (`library_id`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_type_sort_title_nocase_id_idx` ON `metadata` (`type`,COALESCE("sort_title", "title") COLLATE NOCASE,`id`);--> statement-breakpoint
CREATE INDEX `subtitles_media_file_created_idx` ON `subtitles` (`media_file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `history_profile_created_idx` ON `watched_history` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `worker_operations_created_idx` ON `worker_operations` (`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_worker_status_created_idx` ON `worker_jobs` (`worker_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_operation_created_idx` ON `worker_jobs` (`operation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_status_created_idx` ON `worker_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_running_lease_idx` ON `worker_jobs` (`lease_until`) WHERE "worker_jobs"."status" = 'running';
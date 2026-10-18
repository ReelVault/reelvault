DROP INDEX IF EXISTS `collection_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `company_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `episode_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `genre_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `keyword_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `media_files_path_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `media_files_library_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_updated_at_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_title_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_sort_title_nocase_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_match_score_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `person_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `season_providers_provider_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `worker_operations_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `worker_jobs_worker_completed_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_user_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `media_markers_media_file_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_external_ids_metadata_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_collections_collection_idx`;--> statement-breakpoint
CREATE INDEX `collection_providers_provider_idx` ON `collection_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `company_providers_provider_idx` ON `company_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `downloads_media_file_created_idx` ON `downloads` (`media_file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `episode_providers_provider_idx` ON `episode_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `genre_providers_provider_idx` ON `genre_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `keyword_providers_provider_idx` ON `keyword_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `media_artifacts_plugin_created_idx` ON `media_artifacts` (`plugin_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_unlinked_unique` ON `media_files` (`file_path`) WHERE "media_files"."episode_id" IS NULL;--> statement-breakpoint
CREATE INDEX `media_files_library_id_idx` ON `media_files` (`library_id`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_type_sort_title_nocase_id_idx` ON `metadata` (`type`,COALESCE("sort_title", "title") COLLATE NOCASE,`id`);--> statement-breakpoint
CREATE INDEX `metadata_providers_provider_idx` ON `metadata_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `person_providers_provider_idx` ON `person_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `season_providers_provider_idx` ON `season_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `subtitles_media_file_created_idx` ON `subtitles` (`media_file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `history_profile_created_idx` ON `watched_history` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `worker_operations_created_idx` ON `worker_operations` (`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_worker_completed_created_idx` ON `worker_jobs` (`worker_id`,`status`,`completed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_worker_status_created_idx` ON `worker_jobs` (`worker_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_operation_created_idx` ON `worker_jobs` (`operation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_status_created_idx` ON `worker_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_running_lease_idx` ON `worker_jobs` (`lease_until`) WHERE "worker_jobs"."status" = 'running';
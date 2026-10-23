CREATE TABLE `catalog_media_stats` (
	`id` integer PRIMARY KEY,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`movie_count` integer DEFAULT 0 NOT NULL,
	`episode_count` integer DEFAULT 0 NOT NULL,
	`quality_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_media_stats` (
	`library_id` text PRIMARY KEY,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`movie_count` integer DEFAULT 0 NOT NULL,
	`episode_count` integer DEFAULT 0 NOT NULL,
	`quality_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_library_media_stats_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `metadata` ADD `latest_media_created_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_cast_person_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_companies_company_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_crew_person_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_genres_genre_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_keywords_keyword_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `user_ratings_profile_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `history_profile_watched_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `watchlist_profile_created_idx`;--> statement-breakpoint
CREATE INDEX `episodes_number_id_idx` ON `episodes` (`episode_number`,`id`);--> statement-breakpoint
CREATE INDEX `media_artifacts_media_file_kind_idx` ON `media_artifacts` (`media_file_id`,`kind`,`plugin_id`);--> statement-breakpoint
CREATE INDEX `media_files_library_size_idx` ON `media_files` (`library_id`,`file_size`);--> statement-breakpoint
CREATE INDEX `media_files_admin_stats_idx` ON `media_files` (`file_size`,`movie_id`,`episode_id`,`quality_tag`);--> statement-breakpoint
CREATE INDEX `media_files_created_at_id_idx` ON `media_files` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_files_file_name_id_idx` ON `media_files` (`file_name`,`id`);--> statement-breakpoint
CREATE INDEX `media_markers_created_at_id_idx` ON `media_markers` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_type_title_id_idx` ON `metadata` (`type`,`title`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_type_created_id_idx` ON `metadata` (`type`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_admin_stats_idx` ON `metadata` (`type`,`match_score`,`has_missing_translation`);--> statement-breakpoint
CREATE INDEX `metadata_type_latest_media_idx` ON `metadata` (`type`,`latest_media_created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_cast_person_metadata_idx` ON `metadata_cast` (`person_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_cast_metadata_sort_idx` ON `metadata_cast` (`metadata_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `metadata_collections_collection_metadata_idx` ON `metadata_collections` (`collection_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_collections_metadata_sort_idx` ON `metadata_collections` (`metadata_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `metadata_companies_company_metadata_idx` ON `metadata_companies` (`company_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_crew_person_metadata_idx` ON `metadata_crew` (`person_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_genres_genre_metadata_idx` ON `metadata_genres` (`genre_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_keywords_keyword_metadata_idx` ON `metadata_keywords` (`keyword_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `people_name_id_idx` ON `people` (`name`,`id`);--> statement-breakpoint
CREATE INDEX `seasons_number_id_idx` ON `seasons` (`season_number`,`id`);--> statement-breakpoint
CREATE INDEX `user_ratings_profile_created_id_idx` ON `user_ratings` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `history_profile_watched_id_idx` ON `watched_history` (`profile_id`,`watched_at`,`id`);--> statement-breakpoint
CREATE INDEX `watchlist_profile_created_id_idx` ON `watchlist` (`profile_id`,`created_at`,`id`);
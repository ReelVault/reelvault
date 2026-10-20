DROP INDEX IF EXISTS `user_ratings_profile_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `history_profile_watched_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `watchlist_profile_created_idx`;--> statement-breakpoint
CREATE INDEX `episodes_number_id_idx` ON `episodes` (`episode_number`,`id`);--> statement-breakpoint
CREATE INDEX `media_artifacts_media_file_kind_idx` ON `media_artifacts` (`media_file_id`,`kind`,`plugin_id`);--> statement-breakpoint
CREATE INDEX `media_files_created_at_id_idx` ON `media_files` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_files_file_name_id_idx` ON `media_files` (`file_name`,`id`);--> statement-breakpoint
CREATE INDEX `media_markers_created_at_id_idx` ON `media_markers` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_type_title_id_idx` ON `metadata` (`type`,`title`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_type_created_id_idx` ON `metadata` (`type`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_cast_metadata_sort_idx` ON `metadata_cast` (`metadata_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `metadata_collections_metadata_sort_idx` ON `metadata_collections` (`metadata_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `people_name_id_idx` ON `people` (`name`,`id`);--> statement-breakpoint
CREATE INDEX `seasons_number_id_idx` ON `seasons` (`season_number`,`id`);--> statement-breakpoint
CREATE INDEX `user_ratings_profile_created_id_idx` ON `user_ratings` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `history_profile_watched_id_idx` ON `watched_history` (`profile_id`,`watched_at`,`id`);--> statement-breakpoint
CREATE INDEX `watchlist_profile_created_id_idx` ON `watchlist` (`profile_id`,`created_at`,`id`);
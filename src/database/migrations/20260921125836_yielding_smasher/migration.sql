CREATE INDEX `metadata_title_id_idx` ON `metadata` (`title`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_sort_title_nocase_id_idx` ON `metadata` (COALESCE("sort_title", "title") COLLATE NOCASE,`id`);--> statement-breakpoint
CREATE INDEX `metadata_release_date_id_idx` ON `metadata` (`release_date`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_popularity_id_idx` ON `metadata` (`popularity`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_match_score_id_idx` ON `metadata` (`match_score`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_updated_at_id_idx` ON `metadata` (`updated_at`,`id`);
DROP INDEX IF EXISTS `metadata_cast_person_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_companies_company_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_crew_person_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_genres_genre_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `metadata_keywords_keyword_idx`;--> statement-breakpoint
CREATE INDEX `metadata_cast_person_metadata_idx` ON `metadata_cast` (`person_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_collections_collection_metadata_idx` ON `metadata_collections` (`collection_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_companies_company_metadata_idx` ON `metadata_companies` (`company_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_crew_person_metadata_idx` ON `metadata_crew` (`person_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_genres_genre_metadata_idx` ON `metadata_genres` (`genre_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_keywords_keyword_metadata_idx` ON `metadata_keywords` (`keyword_id`,`metadata_id`);
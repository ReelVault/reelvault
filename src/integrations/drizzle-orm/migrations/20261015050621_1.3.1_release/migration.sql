-- Trigram index for the typo-tolerance fallback. drizzle-kit cannot express
-- virtual tables or triggers, so this stays a raw migration (same pattern as
-- `metadata_fts`). The fallback matched `title LIKE '%abc%' OR original_title
-- LIKE '%abc%'`, which no B-tree index can serve, so it scanned the whole
-- metadata table on every uncached miss; a trigram FTS5 table answers the same
-- substring query from the index. Indexed by the source table's implicit rowid
-- so the delete/update triggers stay O(log N) instead of scanning the FTS
-- table through the UNINDEXED id column.
CREATE VIRTUAL TABLE IF NOT EXISTS `metadata_title_trigram` USING fts5(
	`title`,
	`original_title`,
	`metadata_id` UNINDEXED,
	tokenize = 'trigram'
);--> statement-breakpoint
-- A development database that applied an earlier build of this migration already
-- holds these rows; clearing them first keeps the insert from duplicating them.
DELETE FROM `metadata_title_trigram`;--> statement-breakpoint
INSERT INTO `metadata_title_trigram` (`rowid`, `title`, `original_title`, `metadata_id`)
	SELECT `rowid`, `title`, `original_title`, `id` FROM `metadata`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `metadata_title_trigram_insert` AFTER INSERT ON `metadata` BEGIN
	INSERT INTO `metadata_title_trigram` (`rowid`, `title`, `original_title`, `metadata_id`)
	VALUES (new.`rowid`, new.`title`, new.`original_title`, new.`id`);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `metadata_title_trigram_delete` AFTER DELETE ON `metadata` BEGIN
	DELETE FROM `metadata_title_trigram` WHERE `rowid` = old.`rowid`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `metadata_title_trigram_update` AFTER UPDATE OF `title`, `original_title` ON `metadata` BEGIN
	DELETE FROM `metadata_title_trigram` WHERE `rowid` = old.`rowid`;
	INSERT INTO `metadata_title_trigram` (`rowid`, `title`, `original_title`, `metadata_id`)
	VALUES (new.`rowid`, new.`title`, new.`original_title`, new.`id`);
END;

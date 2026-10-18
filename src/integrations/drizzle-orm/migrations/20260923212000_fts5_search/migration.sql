-- FTS5 token search for metadata titles and people names. drizzle-kit cannot
-- express virtual tables or triggers, so this stays a raw migration. Indexed by
-- the source table's implicit rowid so delete/update triggers are O(log N)
-- instead of scanning the whole FTS table through the UNINDEXED id column.
CREATE VIRTUAL TABLE IF NOT EXISTS `metadata_fts` USING fts5(
	`title`,
	`original_title`,
	`metadata_id` UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO `metadata_fts` (`rowid`, `title`, `original_title`, `metadata_id`)
	SELECT `rowid`, `title`, `original_title`, `id` FROM `metadata`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `metadata_fts_insert` AFTER INSERT ON `metadata` BEGIN
	INSERT INTO `metadata_fts` (`rowid`, `title`, `original_title`, `metadata_id`)
	VALUES (new.`rowid`, new.`title`, new.`original_title`, new.`id`);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `metadata_fts_delete` AFTER DELETE ON `metadata` BEGIN
	DELETE FROM `metadata_fts` WHERE `rowid` = old.`rowid`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `metadata_fts_update` AFTER UPDATE OF `title`, `original_title` ON `metadata` BEGIN
	DELETE FROM `metadata_fts` WHERE `rowid` = old.`rowid`;
	INSERT INTO `metadata_fts` (`rowid`, `title`, `original_title`, `metadata_id`)
	VALUES (new.`rowid`, new.`title`, new.`original_title`, new.`id`);
END;--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `people_fts` USING fts5(
	`name`,
	`person_id` UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO `people_fts` (`rowid`, `name`, `person_id`)
	SELECT `rowid`, `name`, `id` FROM `people`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `people_fts_insert` AFTER INSERT ON `people` BEGIN
	INSERT INTO `people_fts` (`rowid`, `name`, `person_id`) VALUES (new.`rowid`, new.`name`, new.`id`);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `people_fts_delete` AFTER DELETE ON `people` BEGIN
	DELETE FROM `people_fts` WHERE `rowid` = old.`rowid`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `people_fts_update` AFTER UPDATE OF `name` ON `people` BEGIN
	DELETE FROM `people_fts` WHERE `rowid` = old.`rowid`;
	INSERT INTO `people_fts` (`rowid`, `name`, `person_id`) VALUES (new.`rowid`, new.`name`, new.`id`);
END;

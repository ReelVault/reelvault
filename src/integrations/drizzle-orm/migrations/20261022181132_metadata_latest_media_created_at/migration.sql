ALTER TABLE `metadata` ADD `latest_media_created_at` integer;--> statement-breakpoint
CREATE INDEX `metadata_type_latest_media_idx` ON `metadata` (`type`,`latest_media_created_at`,`id`);
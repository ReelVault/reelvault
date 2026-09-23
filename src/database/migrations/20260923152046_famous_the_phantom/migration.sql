ALTER TABLE `libraries` ADD `sidecar_flavor` text DEFAULT 'reelvault' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_libraries` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`metadata_storage_mode` text DEFAULT 'database' NOT NULL,
	`sidecar_flavor` text DEFAULT 'reelvault' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "libraries_type_check" CHECK("type" IN ('movies', 'tv_shows')),
	CONSTRAINT "libraries_metadata_storage_mode_check" CHECK("metadata_storage_mode" IN ('database', 'sidecar', 'database_and_sidecar')),
	CONSTRAINT "libraries_sidecar_flavor_check" CHECK("sidecar_flavor" IN ('reelvault', 'kodi'))
);
--> statement-breakpoint
INSERT INTO `__new_libraries`(`id`, `name`, `type`, `metadata_storage_mode`, `created_at`, `updated_at`) SELECT `id`, `name`, `type`, `metadata_storage_mode`, `created_at`, `updated_at` FROM `libraries`;--> statement-breakpoint
DROP TABLE `libraries`;--> statement-breakpoint
ALTER TABLE `__new_libraries` RENAME TO `libraries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_unique` ON `libraries` (`name`,`type`);
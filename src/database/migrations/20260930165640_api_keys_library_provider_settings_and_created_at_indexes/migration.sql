CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scope` text DEFAULT 'read_only' NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_api_keys_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "api_keys_scope_check" CHECK("scope" IN ('read_only', 'full'))
);
--> statement-breakpoint
CREATE TABLE `library_provider_settings` (
	`library_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	CONSTRAINT `library_provider_settings_pk` PRIMARY KEY(`library_id`, `provider_id`),
	CONSTRAINT `fk_library_provider_settings_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_created_by_idx` ON `api_keys` (`created_by`);--> statement-breakpoint
CREATE INDEX `media_files_created_at_idx` ON `media_files` (`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_created_at_idx` ON `worker_jobs` (`created_at`);
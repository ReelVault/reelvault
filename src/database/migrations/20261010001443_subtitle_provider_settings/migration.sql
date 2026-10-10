CREATE TABLE `subtitle_provider_settings` (
	`provider_id` text PRIMARY KEY,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

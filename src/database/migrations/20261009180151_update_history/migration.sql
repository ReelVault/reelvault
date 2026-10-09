CREATE TABLE `update_history` (
	`id` text PRIMARY KEY,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`from_version` text,
	`to_version` text NOT NULL,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_update_history_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `update_history_started_idx` ON `update_history` (`started_at`);--> statement-breakpoint
CREATE INDEX `update_history_status_idx` ON `update_history` (`status`);
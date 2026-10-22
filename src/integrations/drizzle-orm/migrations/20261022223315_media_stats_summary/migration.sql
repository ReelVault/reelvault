CREATE TABLE `catalog_media_stats` (
	`id` integer PRIMARY KEY,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`movie_count` integer DEFAULT 0 NOT NULL,
	`episode_count` integer DEFAULT 0 NOT NULL,
	`quality_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_media_stats` (
	`library_id` text PRIMARY KEY,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`movie_count` integer DEFAULT 0 NOT NULL,
	`episode_count` integer DEFAULT 0 NOT NULL,
	`quality_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_library_media_stats_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE
);

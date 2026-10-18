CREATE TABLE `admin_audit_logs` (
	`id` text PRIMARY KEY,
	`actor_user_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`resource_name` text,
	`summary` text,
	`before_json` text,
	`after_json` text,
	`request_id` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_admin_audit_logs_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`idToken` text,
	`accessToken` text,
	`refreshToken` text,
	`scope` text,
	`password` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL,
	`token` text(255) NOT NULL UNIQUE,
	`ipAddress` text,
	`userAgent` text,
	`impersonatedBy` text,
	`expiresAt` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_session_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `twoFactor` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL,
	`secret` text NOT NULL,
	`backupCodes` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`failedVerificationCount` integer DEFAULT 0 NOT NULL,
	`lockedUntil` integer,
	CONSTRAINT `fk_twoFactor_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text(255) NOT NULL UNIQUE,
	`emailVerified` integer NOT NULL,
	`image` text,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`banReason` text,
	`banExpires` integer,
	`twoFactorEnabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_providers` (
	`collectionId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `collection_providers_pk` PRIMARY KEY(`collectionId`, `provider_id`),
	CONSTRAINT `fk_collection_providers_collectionId_collections_id_fk` FOREIGN KEY (`collectionId`) REFERENCES `collections`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_collection_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`name` text NOT NULL,
	`sort_mode` text DEFAULT 'release_date' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`image_id` text,
	`name` text NOT NULL,
	`original_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_companies_image_id_images_id_fk` FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `company_providers` (
	`companyId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `company_providers_pk` PRIMARY KEY(`companyId`, `provider_id`),
	CONSTRAINT `fk_company_providers_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_company_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `downloads` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`media_file_id` text NOT NULL,
	`quality` text DEFAULT '720p-mobile' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress_percent` real DEFAULT 0 NOT NULL,
	`size_bytes` integer,
	`file_name` text,
	`error_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_downloads_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_downloads_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "downloads_progress_check" CHECK("progress_percent" >= 0 AND "progress_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE `episode_providers` (
	`episodeId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `episode_providers_pk` PRIMARY KEY(`episodeId`, `provider_id`),
	CONSTRAINT `fk_episode_providers_episodeId_episodes_id_fk` FOREIGN KEY (`episodeId`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_episode_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `episode_ratings` (
	`episode_id` text NOT NULL,
	`source` text NOT NULL,
	`label` text,
	`value` real NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`max_value` integer DEFAULT 10 NOT NULL,
	`url` text,
	CONSTRAINT `episode_ratings_pk` PRIMARY KEY(`episode_id`, `source`),
	CONSTRAINT `fk_episode_ratings_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "episode_ratings_values_check" CHECK("max_value" IS NOT NULL AND "max_value" > 0
					AND "value" >= 0 AND "value" <= "max_value"
					AND ("votes" IS NULL OR "votes" >= 0))
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`season_id` text NOT NULL,
	`image_id` text,
	`type` text DEFAULT 'regular' NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_number` integer,
	`title` text,
	`overview` text,
	`air_date` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_episodes_season_id_seasons_id_fk` FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_episodes_image_id_images_id_fk` FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON DELETE SET NULL,
	CONSTRAINT "episodes_type_check" CHECK("type" IN ('regular', 'special')),
	CONSTRAINT "episodes_number_check" CHECK("episode_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE `genre_providers` (
	`genreId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `genre_providers_pk` PRIMARY KEY(`genreId`, `provider_id`),
	CONSTRAINT `fk_genre_providers_genreId_genres_id_fk` FOREIGN KEY (`genreId`) REFERENCES `genres`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_genre_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `genres` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`local_path` text NOT NULL,
	`content_type` text NOT NULL,
	`width` integer,
	`height` integer,
	`file_size` integer,
	`optimization_version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "images_dimensions_check" CHECK(("width" IS NULL OR "width" > 0)
					AND ("height" IS NULL OR "height" > 0)
					AND ("file_size" IS NULL OR "file_size" >= 0))
);
--> statement-breakpoint
CREATE TABLE `keyword_providers` (
	`keywordId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `keyword_providers_pk` PRIMARY KEY(`keywordId`, `provider_id`),
	CONSTRAINT `fk_keyword_providers_keywordId_keywords_id_fk` FOREIGN KEY (`keywordId`) REFERENCES `keywords`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_keyword_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `keywords` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `libraries` (
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
CREATE TABLE `library_paths` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`path` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`metadata_storage_mode` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_library_paths_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "library_paths_metadata_storage_mode_check" CHECK("metadata_storage_mode" IS NULL OR "metadata_storage_mode" IN ('database', 'sidecar', 'database_and_sidecar'))
);
--> statement-breakpoint
CREATE TABLE `media_artifacts` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`media_file_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`kind` text NOT NULL,
	`content_type` text NOT NULL,
	`storage_key` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_media_artifacts_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media_file_ingest_state` (
	`media_file_id` text PRIMARY KEY NOT NULL,
	`sidecar_written_at` integer,
	`discovered_emitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_media_file_ingest_state_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media_file_audio_streams` (
	`media_file_id` text NOT NULL,
	`index` integer NOT NULL,
	`codec_name` text NOT NULL,
	`codec_long_name` text,
	`channels` integer NOT NULL,
	`channel_layout` text,
	`sample_rate` integer,
	`bit_rate` integer,
	`language` text,
	`title` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_forced` integer DEFAULT false NOT NULL,
	`is_commentary` integer DEFAULT false NOT NULL,
	CONSTRAINT `media_file_audio_streams_pk` PRIMARY KEY(`media_file_id`, `index`),
	CONSTRAINT `fk_media_file_audio_streams_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "media_file_audio_stream_values_check" CHECK("index" >= 0
					AND "channels" > 0
					AND ("sample_rate" IS NULL OR "sample_rate" > 0)
					AND ("bit_rate" IS NULL OR "bit_rate" >= 0))
);
--> statement-breakpoint
CREATE TABLE `media_file_video_streams` (
	`media_file_id` text NOT NULL,
	`index` integer NOT NULL,
	`codec_name` text NOT NULL,
	`codec_long_name` text,
	`profile` text,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`pixel_format` text,
	`color_transfer` text,
	`color_primaries` text,
	`color_space` text,
	`dovi_profile` integer,
	`frame_rate` text,
	`bit_rate` integer,
	`language` text,
	`title` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_forced` integer DEFAULT false NOT NULL,
	CONSTRAINT `media_file_video_streams_pk` PRIMARY KEY(`media_file_id`, `index`),
	CONSTRAINT `fk_media_file_video_streams_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "media_file_video_stream_values_check" CHECK("index" >= 0
					AND "width" > 0
					AND "height" > 0
					AND ("bit_rate" IS NULL OR "bit_rate" >= 0))
);
--> statement-breakpoint
CREATE TABLE `media_files` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`metadata_id` text NOT NULL,
	`movie_id` text,
	`episode_id` text,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`format_name` text,
	`duration` integer,
	`file_size` integer,
	`source_mtime_ms` integer,
	`bit_rate` integer,
	`source` text,
	`edition` text,
	`quality_tag` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_media_files_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_media_files_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`),
	CONSTRAINT `fk_media_files_movie_id_movies_id_fk` FOREIGN KEY (`movie_id`) REFERENCES `movies`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_media_files_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "media_files_single_target_check" CHECK(("movie_id" IS NULL) <> ("episode_id" IS NULL)),
	CONSTRAINT "media_files_numeric_values_check" CHECK(("duration" IS NULL OR "duration" >= 0)
					AND ("file_size" IS NULL OR "file_size" >= 0)
					AND ("source_mtime_ms" IS NULL OR "source_mtime_ms" >= 0)
					AND ("bit_rate" IS NULL OR "bit_rate" >= 0))
);
--> statement-breakpoint
CREATE TABLE `media_markers` (
	`id` text PRIMARY KEY,
	`media_file_id` text NOT NULL,
	`type` text NOT NULL,
	`start_seconds` real NOT NULL,
	`end_seconds` real NOT NULL,
	`label` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`plugin_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_media_markers_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "media_markers_range_check" CHECK("start_seconds" >= 0 AND "end_seconds" >= "start_seconds")
);
--> statement-breakpoint
CREATE TABLE `metadata_external_ids` (
	`metadata_id` text NOT NULL,
	`identifier_type` text NOT NULL,
	`identifier` text NOT NULL,
	CONSTRAINT `metadata_external_ids_pk` PRIMARY KEY(`metadata_id`, `identifier_type`),
	CONSTRAINT `fk_metadata_external_ids_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_provider_settings` (
	`provider_id` text PRIMARY KEY,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metadata` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`primary_provider_id` text,
	`title` text NOT NULL,
	`sort_title` text,
	`numbering_mode` text,
	`original_title` text,
	`overview` text,
	`tagline` text,
	`type` text NOT NULL,
	`status` text,
	`release_date` text NOT NULL,
	`origin_country` text,
	`budget` integer,
	`revenue` integer,
	`popularity` real DEFAULT 0 NOT NULL,
	`match_score` real,
	`has_missing_translation` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "metadata_type_check" CHECK("type" IN ('movie', 'tv_show')),
	CONSTRAINT "metadata_numeric_values_check" CHECK(("budget" IS NULL OR "budget" >= 0)
					AND ("revenue" IS NULL OR "revenue" >= 0)
					AND "popularity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `metadata_cast` (
	`metadata_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text NOT NULL,
	`character` text,
	`sort_order` integer DEFAULT -1 NOT NULL,
	CONSTRAINT `metadata_cast_pk` PRIMARY KEY(`metadata_id`, `person_id`, `role`),
	CONSTRAINT `fk_metadata_cast_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_cast_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON DELETE CASCADE,
	CONSTRAINT "metadata_cast_sort_order_check" CHECK("sort_order" IS NULL OR "sort_order" >= -1)
);
--> statement-breakpoint
CREATE TABLE `metadata_collections` (
	`metadata_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `metadata_collections_pk` PRIMARY KEY(`metadata_id`, `collection_id`),
	CONSTRAINT `fk_metadata_collections_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_collections_collection_id_collections_id_fk` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_companies` (
	`metadata_id` text NOT NULL,
	`company_id` text NOT NULL,
	CONSTRAINT `metadata_companies_pk` PRIMARY KEY(`metadata_id`, `company_id`),
	CONSTRAINT `fk_metadata_companies_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_companies_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_crew` (
	`metadata_id` text NOT NULL,
	`person_id` text NOT NULL,
	`job` text NOT NULL,
	`department` text NOT NULL,
	CONSTRAINT `metadata_crew_pk` PRIMARY KEY(`metadata_id`, `person_id`, `job`),
	CONSTRAINT `fk_metadata_crew_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_crew_person_id_people_id_fk` FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_genres` (
	`metadata_id` text NOT NULL,
	`genre_id` text NOT NULL,
	CONSTRAINT `metadata_genres_pk` PRIMARY KEY(`metadata_id`, `genre_id`),
	CONSTRAINT `fk_metadata_genres_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_genres_genre_id_genres_id_fk` FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_images` (
	`metadata_id` text NOT NULL,
	`image_id` text NOT NULL,
	`image_type` text NOT NULL,
	CONSTRAINT `metadata_images_pk` PRIMARY KEY(`metadata_id`, `image_type`, `image_id`),
	CONSTRAINT `fk_metadata_images_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_images_image_id_images_id_fk` FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_keywords` (
	`metadata_id` text NOT NULL,
	`keyword_id` text NOT NULL,
	CONSTRAINT `metadata_keywords_pk` PRIMARY KEY(`metadata_id`, `keyword_id`),
	CONSTRAINT `fk_metadata_keywords_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_keywords_keyword_id_keywords_id_fk` FOREIGN KEY (`keyword_id`) REFERENCES `keywords`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_locked_fields` (
	`metadata_id` text NOT NULL,
	`field` text NOT NULL,
	CONSTRAINT `metadata_locked_fields_pk` PRIMARY KEY(`metadata_id`, `field`),
	CONSTRAINT `fk_metadata_locked_fields_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_providers` (
	`metadataId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `metadata_providers_pk` PRIMARY KEY(`metadataId`, `provider_id`),
	CONSTRAINT `fk_metadata_providers_metadataId_metadata_id_fk` FOREIGN KEY (`metadataId`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_metadata_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_ratings` (
	`metadata_id` text NOT NULL,
	`source` text NOT NULL,
	`label` text,
	`value` real NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`max_value` integer DEFAULT 10 NOT NULL,
	`url` text,
	CONSTRAINT `metadata_ratings_pk` PRIMARY KEY(`metadata_id`, `source`),
	CONSTRAINT `fk_metadata_ratings_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT "metadata_ratings_values_check" CHECK("max_value" IS NOT NULL AND "max_value" > 0
					AND "value" >= 0 AND "value" <= "max_value"
					AND ("votes" IS NULL OR "votes" >= 0))
);
--> statement-breakpoint
CREATE TABLE `movies` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`metadata_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_movies_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL,
	`profile_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`data` text NOT NULL,
	`link` text,
	`source_plugin_id` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_notifications_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_notifications_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`image_id` text,
	`name` text NOT NULL,
	`biography` text,
	`gender` text,
	`birthday` text,
	`known_credits` integer,
	`popularity` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_people_image_id_images_id_fk` FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON DELETE SET NULL,
	CONSTRAINT "people_gender_check" CHECK("gender" IS NULL OR "gender" IN ('male', 'female', 'other')),
	CONSTRAINT "people_numeric_values_check" CHECK(("known_credits" IS NULL OR "known_credits" >= 0)
					AND "popularity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `person_providers` (
	`personId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `person_providers_pk` PRIMARY KEY(`personId`, `provider_id`),
	CONSTRAINT `fk_person_providers_personId_people_id_fk` FOREIGN KEY (`personId`) REFERENCES `people`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_person_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `playback_progress` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`media_file_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`duration` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`audio_stream_index` integer,
	`subtitle_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_playback_progress_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_playback_progress_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "playback_progress_values_check" CHECK("position" >= 0 AND "duration" >= 0)
);
--> statement-breakpoint
CREATE TABLE `plugin_repositories` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`token_encrypted` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_refreshed_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "plugin_repositories_url_check" CHECK("url" LIKE 'http%')
);
--> statement-breakpoint
CREATE TABLE `plugin_blobs` (
	`plugin_id` text NOT NULL,
	`data_key` text NOT NULL,
	`storage_key` text NOT NULL UNIQUE,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `plugin_blobs_pk` PRIMARY KEY(`plugin_id`, `data_key`),
	CONSTRAINT "plugin_blobs_size_check" CHECK("size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `plugin_storage` (
	`plugin_id` text NOT NULL,
	`data_key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `plugin_storage_pk` PRIMARY KEY(`plugin_id`, `data_key`)
);
--> statement-breakpoint
CREATE TABLE `profile_preferences_overrides` (
	`profile_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `profile_preferences_overrides_pk` PRIMARY KEY(`profile_id`, `key`),
	CONSTRAINT `fk_profile_preferences_overrides_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `profile_stream_prefs` (
	`profile_id` text NOT NULL,
	`metadata_id` text NOT NULL,
	`audio_language` text,
	`subtitle_language` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `profile_stream_prefs_pk` PRIMARY KEY(`profile_id`, `metadata_id`),
	CONSTRAINT `fk_profile_stream_prefs_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_profile_stream_prefs_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`pin` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_profiles_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`name` text NOT NULL,
	`entity_type` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "providers_entity_type_check" CHECK("entity_type" IN ('movie', 'tv_show', 'collection', 'company', 'genre', 'keyword', 'person', 'season', 'episode'))
);
--> statement-breakpoint
CREATE TABLE `resource_metrics` (
	`id` text PRIMARY KEY,
	`cpu_used_percent` real NOT NULL,
	`cpu_load_avg_1` real NOT NULL,
	`cpu_load_avg_5` real NOT NULL,
	`cpu_load_avg_15` real NOT NULL,
	`memory_used_mb` integer NOT NULL,
	`memory_total_mb` integer NOT NULL,
	`memory_percent` real NOT NULL,
	`disk_used_gb` real NOT NULL,
	`disk_total_gb` real NOT NULL,
	`disk_percent` real NOT NULL,
	`pressure` text NOT NULL,
	`active_streams` integer DEFAULT 0 NOT NULL,
	`active_workers` text NOT NULL,
	`retention_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scan_findings` (
	`library_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `scan_findings_pk` PRIMARY KEY(`library_id`, `file_path`),
	CONSTRAINT `fk_scan_findings_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "scan_findings_reason_check" CHECK("reason" IN ('recognition_failed', 'type_mismatch', 'no_metadata_match'))
);
--> statement-breakpoint
CREATE TABLE `scan_state` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL UNIQUE,
	`paths_signature` text NOT NULL,
	`scanned_files` integer DEFAULT 0 NOT NULL,
	`new_file_paths` text NOT NULL,
	`changed_media_file_ids` text NOT NULL,
	`ingest_cursor` integer DEFAULT 0 NOT NULL,
	`refresh_cursor` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `season_providers` (
	`seasonId` text NOT NULL,
	`provider_id` text NOT NULL,
	CONSTRAINT `season_providers_pk` PRIMARY KEY(`seasonId`, `provider_id`),
	CONSTRAINT `fk_season_providers_seasonId_seasons_id_fk` FOREIGN KEY (`seasonId`) REFERENCES `seasons`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_season_providers_provider_id_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `season_ratings` (
	`season_id` text NOT NULL,
	`source` text NOT NULL,
	`label` text,
	`value` real NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`max_value` integer DEFAULT 10 NOT NULL,
	`url` text,
	CONSTRAINT `season_ratings_pk` PRIMARY KEY(`season_id`, `source`),
	CONSTRAINT `fk_season_ratings_season_id_seasons_id_fk` FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON DELETE CASCADE,
	CONSTRAINT "season_ratings_values_check" CHECK("max_value" IS NOT NULL AND "max_value" > 0
					AND "value" >= 0 AND "value" <= "max_value"
					AND ("votes" IS NULL OR "votes" >= 0))
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` text PRIMARY KEY,
	`stable_key` text NOT NULL,
	`metadata_id` text NOT NULL,
	`image_id` text,
	`season_number` integer NOT NULL,
	`name` text,
	`overview` text,
	`air_date` text,
	`status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_seasons_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_seasons_image_id_images_id_fk` FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON DELETE SET NULL,
	CONSTRAINT "seasons_number_check" CHECK("season_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE `subtitles` (
	`id` text PRIMARY KEY,
	`media_file_id` text NOT NULL,
	`language` text NOT NULL,
	`label` text,
	`format` text NOT NULL,
	`type` text DEFAULT 'external' NOT NULL,
	`file_path` text,
	`stream_index` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`is_forced` integer DEFAULT false NOT NULL,
	`is_hearing_impaired` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_subtitles_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "subtitles_type_check" CHECK("type" IN ('external', 'embedded')),
	CONSTRAINT "subtitles_source_check" CHECK(("type" = 'external' AND "file_path" IS NOT NULL AND "stream_index" IS NULL)
					OR ("type" = 'embedded' AND "stream_index" IS NOT NULL AND "file_path" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_ratings` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`metadata_id` text NOT NULL,
	`rating` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_user_ratings_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_user_ratings_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE,
	CONSTRAINT "user_ratings_value_check" CHECK("rating" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE `watched_history` (
	`id` text PRIMARY KEY,
	`media_file_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`duration_watched` integer,
	`is_full_watch` integer DEFAULT false NOT NULL,
	`watched_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_watched_history_media_file_id_media_files_id_fk` FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_watched_history_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT "history_duration_check" CHECK("duration_watched" IS NULL OR "duration_watched" >= 0)
);
--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`metadata_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_watchlist_profile_id_profiles_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_watchlist_metadata_id_metadata_id_fk` FOREIGN KEY (`metadata_id`) REFERENCES `metadata`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `worker_operations` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reference_type` text,
	`reference_id` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`total_items` integer DEFAULT 0 NOT NULL,
	`pending_items` integer DEFAULT 0 NOT NULL,
	`running_items` integer DEFAULT 0 NOT NULL,
	`completed_items` integer DEFAULT 0 NOT NULL,
	`failed_items` integer DEFAULT 0 NOT NULL,
	`cancelled_items` integer DEFAULT 0 NOT NULL,
	`progress_percent` integer,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`retention_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_schedules` (
	`id` text PRIMARY KEY,
	`worker_id` text NOT NULL UNIQUE,
	`triggers` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_completed_at` integer,
	`last_status` text,
	`last_duration_ms` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_jobs` (
	`id` text PRIMARY KEY,
	`worker_id` text NOT NULL,
	`operation_id` text,
	`depends_on_job_id` text,
	`dedupe_key` text,
	`reference_type` text,
	`reference_id` text,
	`data` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress_percent` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`backoff_type` text DEFAULT 'exponential' NOT NULL,
	`backoff_delay_ms` integer DEFAULT 1000 NOT NULL,
	`lease_until` integer,
	`runner_id` text,
	`claim_token` text,
	`result` text,
	`error` text,
	`started_at` integer,
	`run_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_worker_jobs_operation_id_worker_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `worker_operations`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_worker_jobs_depends_on_job_id_worker_jobs_id_fk` FOREIGN KEY (`depends_on_job_id`) REFERENCES `worker_jobs`(`id`) ON DELETE SET NULL,
	CONSTRAINT "worker_jobs_status_check" CHECK("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "worker_jobs_backoff_check" CHECK("backoff_type" IN ('fixed', 'exponential')),
	CONSTRAINT "worker_jobs_values_check" CHECK("attempts" >= 0
					AND "max_attempts" > 0
					AND "backoff_delay_ms" >= 0),
	CONSTRAINT "worker_jobs_reference_check" CHECK(("reference_type" IS NULL AND "reference_id" IS NULL)
					OR ("reference_type" IS NOT NULL AND "reference_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `admin_audit_actor_created_idx` ON `admin_audit_logs` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_action_created_idx` ON `admin_audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_resource_created_idx` ON `admin_audit_logs` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_created_id_idx` ON `admin_audit_logs` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `admin_audit_request_idx` ON `admin_audit_logs` (`request_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_ip_idx` ON `admin_audit_logs` (`ip_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`providerId`,`accountId`);--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE INDEX `session_expires_idx` ON `session` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `session_user_expires_idx` ON `session` (`userId`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `session_updated_idx` ON `session` (`updated_at`);--> statement-breakpoint
CREATE INDEX `two_factor_user_idx` ON `twoFactor` (`userId`);--> statement-breakpoint
CREATE INDEX `two_factor_secret_idx` ON `twoFactor` (`secret`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `verification_expires_idx` ON `verification` (`expiresAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `collection_providers_provider_unique` ON `collection_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_unique` ON `collections` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_stable_key_idx` ON `collections` (`stable_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_unique` ON `companies` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_stable_key_idx` ON `companies` (`stable_key`);--> statement-breakpoint
CREATE INDEX `companies_image_idx` ON `companies` (`image_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `company_providers_provider_unique` ON `company_providers` (`provider_id`);--> statement-breakpoint
CREATE INDEX `downloads_profile_status_idx` ON `downloads` (`profile_id`,`status`);--> statement-breakpoint
CREATE INDEX `downloads_profile_created_idx` ON `downloads` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `downloads_status_updated_idx` ON `downloads` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `episode_providers_provider_unique` ON `episode_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_unique` ON `episodes` (`season_id`,`type`,`episode_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_stable_key_idx` ON `episodes` (`stable_key`);--> statement-breakpoint
CREATE INDEX `episodes_season_number_idx` ON `episodes` (`season_id`,`episode_number`);--> statement-breakpoint
CREATE INDEX `episodes_image_idx` ON `episodes` (`image_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `genre_providers_provider_unique` ON `genre_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `genres_unique` ON `genres` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `genres_stable_key_idx` ON `genres` (`stable_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `images_unique` ON `images` (`local_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `images_stable_key_idx` ON `images` (`stable_key`);--> statement-breakpoint
CREATE INDEX `images_optimization_version_idx` ON `images` (`optimization_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_providers_provider_unique` ON `keyword_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `keywords_unique` ON `keywords` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `keywords_stable_key_idx` ON `keywords` (`stable_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_unique` ON `libraries` (`name`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_paths_unique` ON `library_paths` (`path`);--> statement-breakpoint
CREATE INDEX `library_paths_library_idx` ON `library_paths` (`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_paths_stable_key_idx` ON `library_paths` (`stable_key`);--> statement-breakpoint
CREATE INDEX `media_artifacts_media_file_created_idx` ON `media_artifacts` (`media_file_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_artifacts_stable_key_idx` ON `media_artifacts` (`stable_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_unique` ON `media_files` (`file_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_movie_default_unique` ON `media_files` (`movie_id`) WHERE "media_files"."movie_id" IS NOT NULL AND "media_files"."is_default" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_episode_default_unique` ON `media_files` (`episode_id`) WHERE "media_files"."episode_id" IS NOT NULL AND "media_files"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `media_files_library_idx` ON `media_files` (`library_id`);--> statement-breakpoint
CREATE INDEX `media_files_library_created_idx` ON `media_files` (`library_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_files_metadata_created_idx` ON `media_files` (`metadata_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_files_movie_idx` ON `media_files` (`movie_id`);--> statement-breakpoint
CREATE INDEX `media_files_episode_idx` ON `media_files` (`episode_id`);--> statement-breakpoint
CREATE INDEX `media_files_updated_at_idx` ON `media_files` (`updated_at`);--> statement-breakpoint
CREATE INDEX `media_files_file_name_idx` ON `media_files` (`file_name`);--> statement-breakpoint
CREATE INDEX `media_markers_media_file_idx` ON `media_markers` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `media_markers_media_file_type_idx` ON `media_markers` (`media_file_id`,`type`);--> statement-breakpoint
CREATE INDEX `media_markers_file_start_idx` ON `media_markers` (`media_file_id`,`start_seconds`);--> statement-breakpoint
CREATE INDEX `metadata_external_ids_type_value_idx` ON `metadata_external_ids` (`identifier_type`,`identifier`);--> statement-breakpoint
CREATE INDEX `metadata_external_ids_metadata_idx` ON `metadata_external_ids` (`metadata_id`);--> statement-breakpoint
CREATE INDEX `metadata_provider_settings_priority_idx` ON `metadata_provider_settings` (`enabled`,`priority`,`provider_id`);--> statement-breakpoint
CREATE INDEX `metadata_provider_settings_order_idx` ON `metadata_provider_settings` (`priority`,`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `metadata_unique` ON `metadata` (`title`,`type`,`release_date`);--> statement-breakpoint
CREATE INDEX `metadata_type_created_idx` ON `metadata` (`type`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `metadata_stable_key_idx` ON `metadata` (`stable_key`);--> statement-breakpoint
CREATE INDEX `metadata_created_id_idx` ON `metadata` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_updated_at_idx` ON `metadata` (`updated_at`);--> statement-breakpoint
CREATE INDEX `metadata_popularity_created_idx` ON `metadata` (`popularity`,`created_at`);--> statement-breakpoint
CREATE INDEX `metadata_type_popularity_created_idx` ON `metadata` (`type`,`popularity`,`created_at`);--> statement-breakpoint
CREATE INDEX `metadata_type_title_idx` ON `metadata` (`type`,`title`);--> statement-breakpoint
CREATE INDEX `metadata_type_release_date_idx` ON `metadata` (`type`,`release_date`);--> statement-breakpoint
CREATE INDEX `metadata_title_idx` ON `metadata` (`title`);--> statement-breakpoint
CREATE INDEX `metadata_sort_title_nocase_idx` ON `metadata` (COALESCE("sort_title", "title") COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `metadata_match_score_idx` ON `metadata` (`match_score`);--> statement-breakpoint
CREATE INDEX `metadata_missing_translation_idx` ON `metadata` (`has_missing_translation`);--> statement-breakpoint
CREATE INDEX `metadata_title_id_idx` ON `metadata` (`title`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_sort_title_nocase_id_idx` ON `metadata` (COALESCE("sort_title", "title") COLLATE NOCASE,`id`);--> statement-breakpoint
CREATE INDEX `metadata_release_date_id_idx` ON `metadata` (`release_date`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_popularity_id_idx` ON `metadata` (`popularity`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_match_score_id_idx` ON `metadata` (`match_score`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_updated_at_id_idx` ON `metadata` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `metadata_cast_person_idx` ON `metadata_cast` (`person_id`);--> statement-breakpoint
CREATE INDEX `metadata_collections_collection_idx` ON `metadata_collections` (`collection_id`);--> statement-breakpoint
CREATE INDEX `metadata_collections_collection_sort_idx` ON `metadata_collections` (`collection_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `metadata_companies_company_idx` ON `metadata_companies` (`company_id`);--> statement-breakpoint
CREATE INDEX `metadata_crew_person_idx` ON `metadata_crew` (`person_id`);--> statement-breakpoint
CREATE INDEX `metadata_genres_genre_idx` ON `metadata_genres` (`genre_id`);--> statement-breakpoint
CREATE INDEX `metadata_images_image_idx` ON `metadata_images` (`image_id`);--> statement-breakpoint
CREATE INDEX `metadata_keywords_keyword_idx` ON `metadata_keywords` (`keyword_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `metadata_providers_provider_unique` ON `metadata_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `movies_unique` ON `movies` (`metadata_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `movies_stable_key_idx` ON `movies` (`stable_key`);--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`userId`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_profile_created_idx` ON `notifications` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`userId`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_plugin_created_idx` ON `notifications` (`source_plugin_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `people_name_idx` ON `people` (`name`);--> statement-breakpoint
CREATE INDEX `people_popularity_idx` ON `people` (`popularity`);--> statement-breakpoint
CREATE UNIQUE INDEX `people_stable_key_idx` ON `people` (`stable_key`);--> statement-breakpoint
CREATE INDEX `people_image_idx` ON `people` (`image_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `person_providers_provider_unique` ON `person_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `playback_progress_profile_media_unique` ON `playback_progress` (`profile_id`,`media_file_id`);--> statement-breakpoint
CREATE INDEX `playback_progress_media_idx` ON `playback_progress` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `playback_progress_profile_active_idx` ON `playback_progress` (`profile_id`,`completed`,`updated_at`);--> statement-breakpoint
CREATE INDEX `playback_progress_profile_updated_idx` ON `playback_progress` (`profile_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `plugin_repositories_enabled_idx` ON `plugin_repositories` (`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_repositories_url_unique` ON `plugin_repositories` (`url`);--> statement-breakpoint
CREATE INDEX `plugin_blobs_expires_idx` ON `plugin_blobs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `profile_stream_prefs_media_idx` ON `profile_stream_prefs` (`metadata_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_unique` ON `profiles` (`name`,`userId`);--> statement-breakpoint
CREATE INDEX `profiles_user_idx` ON `profiles` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_unique` ON `providers` (`name`,`entity_type`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_stable_key_idx` ON `providers` (`stable_key`);--> statement-breakpoint
CREATE INDEX `resource_metrics_retention_idx` ON `resource_metrics` (`retention_until`);--> statement-breakpoint
CREATE INDEX `resource_metrics_timestamp_idx` ON `resource_metrics` (`created_at`);--> statement-breakpoint
CREATE INDEX `resource_metrics_pressure_idx` ON `resource_metrics` (`pressure`);--> statement-breakpoint
CREATE INDEX `scan_state_library_updated_idx` ON `scan_state` (`library_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `season_providers_provider_unique` ON `season_providers` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_unique` ON `seasons` (`metadata_id`,`season_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_stable_key_idx` ON `seasons` (`stable_key`);--> statement-breakpoint
CREATE INDEX `seasons_image_idx` ON `seasons` (`image_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subtitles_external_unique` ON `subtitles` (`media_file_id`,`language`,`type`) WHERE "subtitles"."type" = 'external';--> statement-breakpoint
CREATE UNIQUE INDEX `subtitles_embedded_unique` ON `subtitles` (`media_file_id`,`stream_index`) WHERE "subtitles"."type" = 'embedded';--> statement-breakpoint
CREATE INDEX `subtitles_media_file_idx` ON `subtitles` (`media_file_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_ratings_unique` ON `user_ratings` (`profile_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `user_ratings_metadata_idx` ON `user_ratings` (`metadata_id`);--> statement-breakpoint
CREATE INDEX `user_ratings_profile_created_idx` ON `user_ratings` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `history_profile_watched_idx` ON `watched_history` (`profile_id`,`watched_at`);--> statement-breakpoint
CREATE INDEX `history_profile_media_idx` ON `watched_history` (`profile_id`,`media_file_id`);--> statement-breakpoint
CREATE INDEX `history_media_file_idx` ON `watched_history` (`media_file_id`);--> statement-breakpoint
CREATE INDEX `history_watched_at_idx` ON `watched_history` (`watched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_unique` ON `watchlist` (`profile_id`,`metadata_id`);--> statement-breakpoint
CREATE INDEX `watchlist_metadata_idx` ON `watchlist` (`metadata_id`);--> statement-breakpoint
CREATE INDEX `watchlist_profile_created_idx` ON `watchlist` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_operations_status_idx` ON `worker_operations` (`status`);--> statement-breakpoint
CREATE INDEX `worker_operations_status_created_idx` ON `worker_operations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_operations_type_status_idx` ON `worker_operations` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `worker_operations_reference_idx` ON `worker_operations` (`reference_type`,`reference_id`);--> statement-breakpoint
CREATE INDEX `worker_operations_retention_idx` ON `worker_operations` (`retention_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `worker_jobs_active_dedupe_unique` ON `worker_jobs` (`worker_id`,`dedupe_key`) WHERE "worker_jobs"."dedupe_key" IS NOT NULL AND "worker_jobs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX `worker_jobs_claim_idx` ON `worker_jobs` (`worker_id`,`status`,`priority`,`run_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_pending_poll_idx` ON `worker_jobs` (`status`,`run_at`,`worker_id`);--> statement-breakpoint
CREATE INDEX `worker_jobs_lease_idx` ON `worker_jobs` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `worker_jobs_worker_completed_idx` ON `worker_jobs` (`worker_id`,`status`,`completed_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_operation_idx` ON `worker_jobs` (`operation_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `worker_jobs_depends_idx` ON `worker_jobs` (`depends_on_job_id`,`status`);
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scan_findings` (
	`library_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `scan_findings_pk` PRIMARY KEY(`library_id`, `file_path`),
	CONSTRAINT `fk_scan_findings_library_id_libraries_id_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "scan_findings_reason_check" CHECK("reason" IN ('recognition_failed', 'type_mismatch', 'no_metadata_match', 'probe_failed'))
);
--> statement-breakpoint
INSERT INTO `__new_scan_findings`(`library_id`, `file_path`, `file_name`, `reason`, `created_at`, `updated_at`) SELECT `library_id`, `file_path`, `file_name`, `reason`, `created_at`, `updated_at` FROM `scan_findings`;--> statement-breakpoint
DROP TABLE `scan_findings`;--> statement-breakpoint
ALTER TABLE `__new_scan_findings` RENAME TO `scan_findings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
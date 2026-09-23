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

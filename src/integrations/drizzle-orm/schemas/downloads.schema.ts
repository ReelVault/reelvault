import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DOWNLOAD_QUALITIES, DOWNLOAD_STATUSES } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { DatabaseHelper } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { mediaFiles } from "./media-files.schema";
import { profiles } from "./profiles.schema";

export const downloads = sqliteTable(
	"downloads",
	{
		...DatabaseHelper.profileMediaFileRefs({ profileId: () => profiles.id, mediaFileId: () => mediaFiles.id }),

		quality: text("quality", { enum: DOWNLOAD_QUALITIES }).notNull().default("720p-mobile"),
		status: text("status", { enum: DOWNLOAD_STATUSES }).notNull().default("pending"),
		progressPercent: real("progress_percent").notNull().default(0),
		sizeBytes: integer("size_bytes"),
		fileName: text("file_name"),
		errorText: text("error_text"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		index("downloads_profile_status_idx").on(t.profileId, t.status),
		index("downloads_profile_created_idx").on(t.profileId, t.createdAt),
		// The only FK without an index: every media-file delete cascaded through a
		// full downloads scan. created_at second serves the per-file list sort.
		index("downloads_media_file_created_idx").on(t.mediaFileId, t.createdAt),
		// Global retention sweep (`findExpired`) filters status + updatedAt without a profile.
		index("downloads_status_updated_idx").on(t.status, t.updatedAt),
		check("downloads_progress_check", sql`${t.progressPercent} >= 0 AND ${t.progressPercent} <= 100`),
	],
);

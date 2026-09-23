import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { mediaFiles } from "./media-files.schema";
import { profiles } from "./profiles.schema";

export const downloads = sqliteTable(
	"downloads",
	{
		id: DatabaseHelper.id,
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		quality: text("quality", { enum: ["original", "1080p-high", "720p-mobile", "480p-low"] as const })
			.notNull()
			.default("720p-mobile"),
		status: text("status", { enum: ["pending", "processing", "completed", "failed", "cancelled"] as const })
			.notNull()
			.default("pending"),
		progressPercent: real("progress_percent").notNull().default(0),
		sizeBytes: integer("size_bytes"),
		fileName: text("file_name"),
		errorText: text("error_text"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		index("downloads_profile_status_idx").on(t.profileId, t.status),
		index("downloads_profile_created_idx").on(t.profileId, t.createdAt),
		// Global retention sweep (`findExpired`) filters status + updatedAt without a profile.
		index("downloads_status_updated_idx").on(t.status, t.updatedAt),
		check("downloads_progress_check", sql`${t.progressPercent} >= 0 AND ${t.progressPercent} <= 100`),
	],
);

import { playbackArtifactKinds } from "@reelvault/sdk/common";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { mediaFiles } from "./media-files.schema";

export const mediaArtifacts = sqliteTable(
	"media_artifacts",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		pluginId: text("plugin_id").notNull(),
		kind: text("kind", { enum: playbackArtifactKinds }).notNull(),
		contentType: text("content_type").notNull(),
		storageKey: text("storage_key").notNull().unique(),

		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("media_artifacts_media_file_created_idx").on(table.mediaFileId, table.createdAt),
		uniqueIndex("media_artifacts_stable_key_idx").on(table.stableKey),
	],
);

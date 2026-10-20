import { playbackArtifactKinds } from "@reelvault/sdk/common";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { mediaFiles } from "./media-files.schema";

export const mediaArtifacts = sqliteTable(
	"media_artifacts",
	{
		id: idColumn,
		stableKey: text("stable_key").notNull(),
		mediaFileId: tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		pluginId: text("plugin_id").notNull(),
		kind: text("kind", { enum: playbackArtifactKinds }).notNull(),
		contentType: text("content_type").notNull(),
		storageKey: text("storage_key").notNull().unique(),

		...timestampColumns,
	},
	(table) => [
		index("media_artifacts_media_file_created_idx").on(table.mediaFileId, table.createdAt),
		// Plugin artifact cleanup scans by plugin and sorts newest-first.
		index("media_artifacts_plugin_created_idx").on(table.pluginId, table.createdAt),
		// The artifact store filters one file's artifacts by kind and owner.
		index("media_artifacts_media_file_kind_idx").on(table.mediaFileId, table.kind, table.pluginId),
		uniqueIndex("media_artifacts_stable_key_idx").on(table.stableKey),
	],
);

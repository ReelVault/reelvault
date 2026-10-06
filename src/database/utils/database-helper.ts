import {
	type AnySQLiteColumn,
	index,
	integer,
	type ReferenceConfig,
	type SQLiteTableExtraConfigValue,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";

export const DatabaseHelper = {
	id: text("id")
		.primaryKey()
		.notNull()
		.$defaultFn(() => uuidv7()),

	nullableTableRef(id: string, ref: ReferenceConfig["ref"], actions?: ReferenceConfig["actions"]) {
		return text(id).references(ref, { ...actions });
	},

	tableRef(id: string, ref: ReferenceConfig["ref"], actions?: ReferenceConfig["actions"]) {
		return DatabaseHelper.nullableTableRef(id, ref, actions).notNull();
	},

	/**
	 * Shared `id` + `stable_key` + nullable `image_id` column block for
	 * image-owning named entities (companies, people).
	 */
	namedEntityImageColumns(imageRef: ReferenceConfig["ref"]) {
		return {
			id: DatabaseHelper.id,
			stableKey: text("stable_key").notNull(),
			imageId: DatabaseHelper.nullableTableRef("image_id", imageRef, { onDelete: "set null" }),
		};
	},

	/** Unique stable-key + image FK indexes paired with {@link namedEntityImageColumns}. */
	namedEntityImageIndexes(tableName: string, t: { stableKey: AnySQLiteColumn; imageId: AnySQLiteColumn }): SQLiteTableExtraConfigValue[] {
		return [uniqueIndex(`${tableName}_stable_key_idx`).on(t.stableKey), index(`${tableName}_image_idx`).on(t.imageId)];
	},

	/** Shared `id` + `profile_id` + `media_file_id` cascade-FK block (downloads, playback progress). */
	profileMediaFileRefs(refs: { profileId: ReferenceConfig["ref"]; mediaFileId: ReferenceConfig["ref"] }) {
		return {
			id: DatabaseHelper.id,
			profileId: DatabaseHelper.tableRef("profile_id", refs.profileId, { onDelete: "cascade" }),
			mediaFileId: DatabaseHelper.tableRef("media_file_id", refs.mediaFileId, { onDelete: "cascade" }),
		};
	},

	timestamps: {
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
};

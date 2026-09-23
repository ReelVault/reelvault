import { integer, type ReferenceConfig, text } from "drizzle-orm/sqlite-core";
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

	timestamps: {
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
};

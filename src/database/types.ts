import type { Database } from "bun:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import type { relations } from "./relations";
import type { schema } from "./schema";

export type DatabaseType = ReturnType<typeof drizzle<typeof relations, Database>>;

export type DatabaseTransaction = DatabaseType;
type DatabaseSchema = typeof schema;

export type DatabaseTables = keyof DatabaseSchema;

export type InferTable<TTable extends DatabaseTables> = InferSelectModel<DatabaseSchema[TTable]>;

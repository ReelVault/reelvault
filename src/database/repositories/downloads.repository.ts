import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import type { schema } from "@/database/schema";
import { defineRepository, defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import type { DownloadQuality, DownloadStatus } from "@/modules/downloads/download-quality.utils";
import { ConflictError } from "@/utils/errors";

export type DownloadRow = typeof schema.downloads.$inferSelect;

/** Bounds the list queries (admin/user download pages) — no unbounded selects. */
const MAX_LIST_ROWS = 500;

export interface DownloadInsert {
	profileId: string;
	mediaFileId: string;
	quality: DownloadQuality;
}

export interface DownloadUpdate {
	status?: DownloadStatus;
	progressPercent?: number;
	sizeBytes?: number | null;
	fileName?: string | null;
	errorText?: string | null;
}

const downloads = defineTableAccess("downloads", {
	primaryKeyColumn: "id",
});

const overrides = {
	async insert(values: DownloadInsert, tx?: DatabaseTransaction): Promise<DownloadRow> {
		const [row] = await downloads.insertReturning({ values, tx });
		if (!row) throw new ConflictError("Failed to insert download");

		return row;
	},

	async findById(id: string): Promise<DownloadRow | undefined> {
		const rows = await databaseFactory.getClient().select().from(downloads.table).where(eq(downloads.table.id, id)).limit(1);

		return rows[0];
	},

	async findByProfile(profileId: string, limit = MAX_LIST_ROWS): Promise<DownloadRow[]> {
		return await databaseFactory
			.getClient()
			.select()
			.from(downloads.table)
			.where(eq(downloads.table.profileId, profileId))
			.orderBy(desc(downloads.table.createdAt))
			.limit(limit);
	},

	async findAll(limit = MAX_LIST_ROWS): Promise<DownloadRow[]> {
		return await databaseFactory.getClient().select().from(downloads.table).orderBy(desc(downloads.table.createdAt)).limit(limit);
	},

	async findExpired(retentionDays: number, limit = 500): Promise<DownloadRow[]> {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

		return await databaseFactory
			.getClient()
			.select()
			.from(downloads.table)
			.where(and(inArray(downloads.table.status, ["completed", "failed", "cancelled"]), lt(downloads.table.updatedAt, new Date(cutoff))))
			.limit(limit);
	},

	async storageUsedByProfile(profileId: string): Promise<number> {
		const rows = await databaseFactory
			.getClient()
			.select({ used: sql<number>`coalesce(sum(${downloads.table.sizeBytes}), 0)` })
			.from(downloads.table)
			.where(and(eq(downloads.table.profileId, profileId), eq(downloads.table.status, "completed")));

		return rows[0]?.used ?? 0;
	},

	async countActiveByProfile(profileId: string): Promise<number> {
		const rows = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(downloads.table)
			.where(and(eq(downloads.table.profileId, profileId), inArray(downloads.table.status, ["pending", "processing"])));

		return rows[0]?.count ?? 0;
	},

	async update(id: string, values: DownloadUpdate): Promise<void> {
		await downloads.update({ primaryId: id, values });
	},

	async delete(id: string): Promise<void> {
		await downloads.delete({ primaryId: id });
	},
};

export const downloadsRepository = defineRepository(downloads, overrides);

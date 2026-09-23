import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
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

export class DownloadsRepository {
	readonly table = schema.downloads;
	readonly primaryKeyColumn = downloads.primaryKeyColumn;
	readonly query = downloads.query;
	readonly selectMany = downloads.selectMany;
	readonly selectFirst = downloads.selectFirst;
	readonly insertGeneric = downloads.insert;
	readonly insertReturning = downloads.insertReturning;
	readonly updateGeneric = downloads.update;
	readonly updateReturning = downloads.updateReturning;
	readonly updateAndReturn = downloads.updateAndReturn;
	readonly deleteGeneric = downloads.delete;
	readonly deleteReturning = downloads.deleteReturning;
	readonly deleteAndReturn = downloads.deleteAndReturn;
	readonly findByIds = downloads.findByIds;
	readonly findByColumnIn = downloads.findByColumnIn;

	async insert(values: DownloadInsert, tx?: DatabaseTransaction): Promise<DownloadRow> {
		const [row] = await downloads.insertReturning({ values, tx });
		if (!row) throw new ConflictError("Failed to insert download");

		return row;
	}

	async findById(id: string): Promise<DownloadRow | undefined> {
		const rows = await databaseFactory.getClient().select().from(this.table).where(eq(this.table.id, id)).limit(1);

		return rows[0];
	}

	async findByProfile(profileId: string, limit = MAX_LIST_ROWS): Promise<DownloadRow[]> {
		return await databaseFactory
			.getClient()
			.select()
			.from(this.table)
			.where(eq(this.table.profileId, profileId))
			.orderBy(desc(this.table.createdAt))
			.limit(limit);
	}

	async findAll(limit = MAX_LIST_ROWS): Promise<DownloadRow[]> {
		return await databaseFactory.getClient().select().from(this.table).orderBy(desc(this.table.createdAt)).limit(limit);
	}

	async findExpired(retentionDays: number, limit = 500): Promise<DownloadRow[]> {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

		return await databaseFactory
			.getClient()
			.select()
			.from(this.table)
			.where(and(inArray(this.table.status, ["completed", "failed", "cancelled"]), lt(this.table.updatedAt, new Date(cutoff))))
			.limit(limit);
	}

	async storageUsedByProfile(profileId: string): Promise<number> {
		const rows = await databaseFactory
			.getClient()
			.select({ used: sql<number>`coalesce(sum(${this.table.sizeBytes}), 0)` })
			.from(this.table)
			.where(and(eq(this.table.profileId, profileId), eq(this.table.status, "completed")));

		return rows[0]?.used ?? 0;
	}

	async countActiveByProfile(profileId: string): Promise<number> {
		const rows = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(this.table)
			.where(and(eq(this.table.profileId, profileId), inArray(this.table.status, ["pending", "processing"])));

		return rows[0]?.count ?? 0;
	}

	async update(id: string, values: DownloadUpdate): Promise<void> {
		await downloads.update({ primaryId: id, values });
	}

	async delete(id: string): Promise<void> {
		await downloads.delete({ primaryId: id });
	}
}

export const downloadsRepository = new DownloadsRepository();

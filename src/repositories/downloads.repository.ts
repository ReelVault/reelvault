import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DownloadStatus } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { DownloadInsert, DownloadUpdate } from "@/modules/downloads/downloads.ports";
import { DomainError } from "@/utils/domain.errors";

export type DownloadRow = typeof schema.downloads.$inferSelect;

/** Bounds the list queries (admin/user download pages) — no unbounded selects. */
const MAX_LIST_ROWS = 500;

const downloads = defineTableAccess("downloads", {
	primaryKeyColumn: "id",
});

/** Downloads of one profile in one state — `processing` runs now, `pending` waits for a slot. */
async function countByProfileAndStatus(profileId: string, status: DownloadStatus): Promise<number> {
	return await downloads.count({ where: and(eq(downloads.table.profileId, profileId), eq(downloads.table.status, status)) });
}

const overrides = {
	async insert(values: DownloadInsert, tx?: DatabaseTransaction): Promise<DownloadRow> {
		const [row] = await downloads.insertReturning({ values, tx });
		if (!row) throw new DomainError("internal", "Failed to insert download", { code: "downloads.create_failed" });

		return row;
	},

	async findById(id: string): Promise<DownloadRow | undefined> {
		return await downloads.selectFirstById({ primaryId: id });
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

	/** One page of every profile's downloads, newest first, narrowed to one status when asked; `total` counts the same filter. */
	async findPage({
		status,
		limit,
		offset,
	}: {
		status?: DownloadStatus | undefined;
		limit: number;
		offset: number;
	}): Promise<{ data: DownloadRow[]; total: number }> {
		const where = status ? eq(downloads.table.status, status) : undefined;

		return await downloads.findOffsetPage({
			where,
			orderBy: desc(downloads.table.createdAt),
			limit,
			offset,
		});
	},

	/** Downloads per status across every profile, for the admin overview's counters. */
	async countByStatus(): Promise<Record<DownloadStatus, number>> {
		const rows = await databaseFactory
			.getClient()
			.select({ status: downloads.table.status, count: count() })
			.from(downloads.table)
			.groupBy(downloads.table.status);
		const counts: Record<DownloadStatus, number> = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
		for (const row of rows) counts[row.status] = row.count;

		return counts;
	},

	/** The ids among `ids` that still have a download row. */
	async findExistingIds(ids: readonly string[]): Promise<Set<string>> {
		return await downloads.findExistingIds(ids);
	},

	/** Active (pending/processing) rows across profiles — the boot reconciliation source. */
	async findByStatuses(statuses: readonly DownloadStatus[], limit = MAX_LIST_ROWS): Promise<DownloadRow[]> {
		if (statuses.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select()
			.from(downloads.table)
			.where(inArray(downloads.table.status, [...statuses]))
			.orderBy(asc(downloads.table.createdAt))
			.limit(limit);
	},

	async findExpired(retentionDays: number, limit = 500): Promise<DownloadRow[]> {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

		return await databaseFactory
			.getClient()
			.select()
			.from(downloads.table)
			.where(and(inArray(downloads.table.status, ["completed", "failed", "cancelled"]), lt(downloads.table.updatedAt, new Date(cutoff))))
			.orderBy(asc(downloads.table.updatedAt))
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

	/** Downloads of the profile that run right now: they hold its running slots. */
	async countProcessingByProfile(profileId: string): Promise<number> {
		return await countByProfileAndStatus(profileId, "processing");
	},

	/** Downloads of the profile waiting for a running slot. */
	async countPendingByProfile(profileId: string): Promise<number> {
		return await countByProfileAndStatus(profileId, "pending");
	},

	/** True while the profile has this file waiting or running: a second copy of the same download would repeat the work. */
	async hasActiveByProfileAndMedia(profileId: string, mediaFileId: string): Promise<boolean> {
		return await downloads.isExists({
			where: and(
				eq(downloads.table.profileId, profileId),
				eq(downloads.table.mediaFileId, mediaFileId),
				inArray(downloads.table.status, ["pending", "processing"]),
			),
		});
	},

	/** The profile's waiting downloads, oldest first: the next ones to start as running slots free up. */
	async findPendingByProfile(profileId: string, limit: number): Promise<DownloadRow[]> {
		return await databaseFactory
			.getClient()
			.select()
			.from(downloads.table)
			.where(and(eq(downloads.table.profileId, profileId), eq(downloads.table.status, "pending")))
			.orderBy(asc(downloads.table.createdAt), asc(downloads.table.id))
			.limit(limit);
	},

	/**
	 * Moves a waiting download to `processing`, but only while its profile has a free running slot. The check and the
	 * update are one statement, so two workers cannot both take the last slot. False means it did not start.
	 */
	async claimForProcessing(id: string, profileId: string, maxRunning: number): Promise<boolean> {
		const runningInProfile = databaseFactory
			.getClient()
			.select({ count: count() })
			.from(downloads.table)
			.where(and(eq(downloads.table.profileId, profileId), eq(downloads.table.status, "processing")));
		const result = await databaseFactory
			.getClient()
			.update(downloads.table)
			.set({ status: "processing" })
			.where(and(eq(downloads.table.id, id), eq(downloads.table.status, "pending"), sql`(${runningInProfile}) < ${maxRunning}`));

		return result.changes > 0;
	},

	async update(id: string, values: DownloadUpdate): Promise<void> {
		await downloads.update({ primaryId: id, values });
	},

	async delete(id: string): Promise<void> {
		await downloads.delete({ primaryId: id });
	},
};

export const downloadsRepository = defineRepository(downloads, overrides);

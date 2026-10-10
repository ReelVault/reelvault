import type { ScanFindingStatus } from "@reelvault/sdk/common";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { forEachChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import type { ScanFindingReason } from "@/modules/scanner/scanner.types";

export interface ScanFindingInput {
	libraryId: string;
	filePath: string;
	fileName: string;
	reason: ScanFindingReason;
}

export interface ScanFindingItem {
	filePath: string;
	fileName: string;
	reason: ScanFindingReason;
}

export class ScanFindingsRepository {
	readonly table = schema.scanFindings;
	private readonly database: Pick<DatabaseFactory, "getClient" | "runWrite">;

	constructor(database: Pick<DatabaseFactory, "getClient" | "runWrite"> = databaseFactory) {
		this.database = database;
	}

	/**
	 * Standalone writes queue on the transaction lock so a concurrent open
	 * transaction can't make them busy-wait on the event loop; writes already
	 * inside a caller's transaction run directly.
	 */
	private async write<T>(run: (tx?: DatabaseTransaction) => Promise<T>, tx?: DatabaseTransaction): Promise<T> {
		if (tx) return await run(tx);

		return await this.database.runWrite(async () => await run());
	}

	async upsert(input: ScanFindingInput, tx?: DatabaseTransaction): Promise<void> {
		await this.write(async (activeTx) => {
			await this.database
				.getClient({ tx: activeTx })
				.insert(this.table)
				.values({
					libraryId: input.libraryId,
					filePath: input.filePath,
					fileName: input.fileName,
					reason: input.reason,
				})
				.onConflictDoUpdate({
					target: [this.table.libraryId, this.table.filePath],
					set: { fileName: input.fileName, reason: input.reason, updatedAt: new Date() },
				});
		}, tx);
	}

	async remove(libraryId: string, filePath: string, tx?: DatabaseTransaction): Promise<void> {
		await this.write(async (activeTx) => {
			await this.database
				.getClient({ tx: activeTx })
				.delete(this.table)
				.where(and(eq(this.table.libraryId, libraryId), eq(this.table.filePath, filePath)));
		}, tx);
	}

	/** Bulk delete chunked to SQLite's bound-variable limit (one statement per chunk). */
	async removeMany(libraryId: string, filePaths: readonly string[], tx?: DatabaseTransaction): Promise<void> {
		await this.write(async (activeTx) => {
			await forEachChunked(filePaths, async (chunk) => {
				await this.database
					.getClient({ tx: activeTx })
					.delete(this.table)
					.where(and(eq(this.table.libraryId, libraryId), inArray(this.table.filePath, chunk)));
			});
		}, tx);
	}

	/** Findings of one status; with no status, every finding (pruning needs both). */
	async list(libraryId: string, status?: ScanFindingStatus, tx?: DatabaseTransaction): Promise<ScanFindingItem[]> {
		const conditions = [eq(this.table.libraryId, libraryId)];
		if (status) conditions.push(status === "ignored" ? isNotNull(this.table.ignoredAt) : isNull(this.table.ignoredAt));

		return await this.database
			.getClient({ tx })
			.select({ filePath: this.table.filePath, fileName: this.table.fileName, reason: this.table.reason })
			.from(this.table)
			.where(and(...conditions))
			.orderBy(this.table.filePath);
	}

	/** Active and ignored counts for the status tabs, read in one query. */
	async countByStatus(libraryId: string): Promise<{ active: number; ignored: number }> {
		const [counts] = await this.database
			.getClient()
			.select({
				active: sql<number>`coalesce(sum(case when ${this.table.ignoredAt} is null then 1 else 0 end), 0)`,
				ignored: sql<number>`coalesce(sum(case when ${this.table.ignoredAt} is not null then 1 else 0 end), 0)`,
			})
			.from(this.table)
			.where(eq(this.table.libraryId, libraryId));

		return { active: counts?.active ?? 0, ignored: counts?.ignored ?? 0 };
	}

	async findByPath(libraryId: string, filePath: string): Promise<ScanFindingItem | null> {
		const [finding] = await this.database
			.getClient()
			.select({ filePath: this.table.filePath, fileName: this.table.fileName, reason: this.table.reason })
			.from(this.table)
			.where(and(eq(this.table.libraryId, libraryId), eq(this.table.filePath, filePath)))
			.limit(1);

		return finding ?? null;
	}

	/** Ignores a finding, or restores it when `ignored` is false. Resolves false when no finding has that path. */
	async setIgnored(libraryId: string, filePath: string, ignored: boolean, tx?: DatabaseTransaction): Promise<boolean> {
		const updated = await this.write(
			async (activeTx) =>
				await this.database
					.getClient({ tx: activeTx })
					.update(this.table)
					.set({ ignoredAt: ignored ? new Date() : null })
					.where(and(eq(this.table.libraryId, libraryId), eq(this.table.filePath, filePath)))
					.returning({ filePath: this.table.filePath }),
			tx,
		);

		return updated.length > 0;
	}

	/**
	 * Drops findings for files that are gone from disk or no longer enumerated
	 * (e.g. a file became hidden, or the scan covered only some roots) — only
	 * findings inside the scanned roots are considered.
	 */
	async pruneStale(libraryId: string, scannedFilePaths: readonly string[], scannedRoots: readonly string[]): Promise<void> {
		if (scannedRoots.length === 0) return;

		const findings = await this.list(libraryId);
		if (findings.length === 0) return;

		const seen = new Set(scannedFilePaths);
		const stalePaths: string[] = [];
		for (const finding of findings) {
			const withinScannedRoot = scannedRoots.some((root) => finding.filePath.startsWith(root.endsWith("/") ? root : `${root}/`));
			if (withinScannedRoot && !seen.has(finding.filePath)) {
				stalePaths.push(finding.filePath);
			}
		}

		await this.removeMany(libraryId, stalePaths);
	}
}

export const scanFindingsRepository = new ScanFindingsRepository();

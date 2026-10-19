import type { ScanFindingStatus } from "@reelvault/sdk/common";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { ScanFindingReason } from "@/integrations/drizzle-orm/constants/scan-findings.constants";
import { type DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";

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

	/**
	 * Findings of one status plus the active/ignored counts for the status tabs
	 * in ONE statement: the data rows UNION a single counts row (an empty path
	 * marks it). The counts row also carries whether the library row exists, so
	 * the caller's not-found check costs no extra round trip (with warm caches
	 * the check bought nothing at all).
	 */
	listWithCounts(
		libraryId: string,
		status?: ScanFindingStatus,
	): { items: ScanFindingItem[]; counts: { active: number; ignored: number }; libraryExists: boolean } {
		let statusCondition = sql``;
		if (status === "ignored") statusCondition = sql`AND ignored_at IS NOT NULL`;
		else if (status === "active") statusCondition = sql`AND ignored_at IS NULL`;
		const rows = this.database.getClient().all<{
			filePath: string;
			fileName: string;
			reason: ScanFindingReason;
			activeCount: number | null;
			ignoredCount: number | null;
			libraryExists: number | null;
		}>(sql`
			SELECT file_path AS filePath, file_name AS fileName, reason AS reason, NULL AS activeCount, NULL AS ignoredCount, NULL AS libraryExists
			FROM scan_findings
			WHERE library_id = ${libraryId} ${statusCondition}
			UNION ALL
			SELECT '', '', '', coalesce(sum(CASE WHEN ignored_at IS NULL THEN 1 ELSE 0 END), 0), coalesce(sum(CASE WHEN ignored_at IS NOT NULL THEN 1 ELSE 0 END), 0), (SELECT count(*) FROM libraries WHERE id = ${libraryId})
			FROM scan_findings
			WHERE library_id = ${libraryId}
			ORDER BY filePath
		`);

		const items: ScanFindingItem[] = [];
		let active = 0;
		let ignored = 0;
		let libraryExists = false;
		for (const row of rows) {
			if (row.filePath.length === 0) {
				active = row.activeCount ?? 0;
				ignored = row.ignoredCount ?? 0;
				libraryExists = row.libraryExists === 1;
				continue;
			}

			items.push({ filePath: row.filePath, fileName: row.fileName, reason: row.reason });
		}

		return { items, counts: { active, ignored }, libraryExists };
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

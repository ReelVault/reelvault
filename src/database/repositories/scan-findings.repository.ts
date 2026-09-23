import { and, eq } from "drizzle-orm";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
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
	private readonly database: Pick<DatabaseFactory, "getClient">;

	constructor(database: Pick<DatabaseFactory, "getClient"> = databaseFactory) {
		this.database = database;
	}

	async upsert(input: ScanFindingInput, tx?: DatabaseTransaction): Promise<void> {
		await this.database
			.getClient({ tx })
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
	}

	async remove(libraryId: string, filePath: string, tx?: DatabaseTransaction): Promise<void> {
		await this.database
			.getClient({ tx })
			.delete(this.table)
			.where(and(eq(this.table.libraryId, libraryId), eq(this.table.filePath, filePath)));
	}

	async list(libraryId: string, tx?: DatabaseTransaction): Promise<ScanFindingItem[]> {
		return await this.database
			.getClient({ tx })
			.select({ filePath: this.table.filePath, fileName: this.table.fileName, reason: this.table.reason })
			.from(this.table)
			.where(eq(this.table.libraryId, libraryId))
			.orderBy(this.table.filePath);
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
		for (const finding of findings) {
			const withinScannedRoot = scannedRoots.some((root) => finding.filePath.startsWith(root.endsWith("/") ? root : `${root}/`));
			if (withinScannedRoot && !seen.has(finding.filePath)) {
				await this.remove(libraryId, finding.filePath);
			}
		}
	}
}

export const scanFindingsRepository = new ScanFindingsRepository();

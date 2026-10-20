import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const scanState = schema.scanState;
const scanStateAccess = defineTableAccess("scanState", { primaryKeyColumn: "libraryId" });

export interface ScanCheckpoint {
	pathsSignature: string;
	scannedFiles: number;
	newFilePaths: string[];
	changedMediaFileIds: string[];
	ingestCursor: number;
	refreshCursor: number;
}

export const scanStateRepository = {
	async get(libraryId: string): Promise<ScanCheckpoint | undefined> {
		const [row] = await databaseFactory.getClient().select().from(scanState).where(eq(scanState.libraryId, libraryId)).limit(1);
		if (!row) return undefined;

		return {
			pathsSignature: row.pathsSignature,
			scannedFiles: row.scannedFiles,
			newFilePaths: Array.isArray(row.newFilePaths) ? row.newFilePaths : [],
			changedMediaFileIds: Array.isArray(row.changedMediaFileIds) ? row.changedMediaFileIds : [],
			ingestCursor: row.ingestCursor,
			refreshCursor: row.refreshCursor,
		};
	},

	async set(libraryId: string, checkpoint: ScanCheckpoint): Promise<void> {
		const now = new Date();
		await scanStateAccess.upsert({
			values: { id: crypto.randomUUID(), libraryId, ...checkpoint },
			target: scanStateAccess.table.libraryId,
			set: { ...checkpoint, updatedAt: now },
		});
	},

	/**
	 * Advances only the cursors. The enqueue loops call this after every batch;
	 * rewriting the full path arrays each time was O(n²) write volume on the
	 * synchronous SQLite connection.
	 */
	async setCursors(libraryId: string, cursors: { ingestCursor: number; refreshCursor: number }): Promise<void> {
		await databaseFactory
			.getClient()
			.update(scanState)
			.set({ ...cursors, updatedAt: new Date() })
			.where(eq(scanState.libraryId, libraryId));
	},

	async delete(libraryId: string): Promise<void> {
		await databaseFactory.getClient().delete(scanState).where(eq(scanState.libraryId, libraryId));
	},
};

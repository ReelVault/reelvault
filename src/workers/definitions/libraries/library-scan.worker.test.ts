import { describe, expect, test } from "bun:test";
import type { LibraryWithRelations } from "@reelvault/sdk/common";
import type { ScanCheckpoint } from "@/database/repositories/scan-state.repository";
import { type LibraryScanTaskDependencies, scanLibraryTask } from "./library-scan.worker";

interface TestHarness {
	dependencies: LibraryScanTaskDependencies;
	events: string[];
	checkpoints: Map<string, ScanCheckpoint>;
	ingested: string[];
	refreshed: string[];
}

function createHarness(options?: {
	scanResult?: { filePaths: string[]; newFilePaths: string[]; changedMediaFileIds: string[] };
	failIngestAt?: number;
}): TestHarness {
	const events: string[] = [];
	const checkpoints = new Map<string, ScanCheckpoint>();
	const ingested: string[] = [];
	const refreshed: string[] = [];
	const library: LibraryWithRelations = {
		id: "library-1",
		name: "Movies",
		type: "movies",
		metadataStorageMode: "database",
		sidecarFlavor: "reelvault",
		createdAt: new Date(0),
		updatedAt: new Date(0),
		paths: [],
		mediaFiles: [],
	};
	let ingestCalls = 0;
	const dependencies: LibraryScanTaskDependencies = {
		findLibrary: () => Promise.resolve(library),
		scanPaths: (_libraryId, type, paths) => {
			events.push(`scan:${type}:${paths.join(",")}`);

			return Promise.resolve(options?.scanResult ?? { filePaths: [], newFilePaths: [], changedMediaFileIds: [] });
		},
		enqueueMediaFileIngest: (data) => {
			ingestCalls += 1;
			if (options?.failIngestAt !== undefined && ingestCalls > options.failIngestAt) {
				return Promise.reject(new Error("aborted mid-enqueue"));
			}

			ingested.push(data.filePath);

			return Promise.resolve({ id: `ingest-${ingestCalls}` });
		},
		enqueueMediaFileRefresh: (mediaFileId) => {
			refreshed.push(mediaFileId);

			return Promise.resolve({ id: `refresh-${mediaFileId}` });
		},
		publishScanStarted: () => events.push("started"),
		emitScanCompleted: (input) => {
			events.push(`completed:errors=${input.errors}`);

			return Promise.resolve();
		},
		notifyScanCompleted: (input) => events.push(`notified:${input.libraryId}${input.libraryTitle ? `:${input.libraryTitle}` : ""}`),
		loadCheckpoint: (libraryId) => Promise.resolve(checkpoints.get(libraryId)),
		saveCheckpoint: (libraryId, checkpoint) => {
			checkpoints.set(libraryId, structuredClone(checkpoint));
			events.push("checkpoint");

			return Promise.resolve();
		},
		deleteCheckpoint: (libraryId) => {
			checkpoints.delete(libraryId);
			events.push("checkpoint-cleared");

			return Promise.resolve();
		},
	};

	return { dependencies, events, checkpoints, ingested, refreshed };
}

describe("library scan application task", () => {
	test("keeps scan orchestration independent from worker runtime", async () => {
		const { dependencies, events } = createHarness();

		await expect(
			scanLibraryTask({ libraryId: "library-1", paths: ["/media"] }, { correlationId: "scan-1" }, dependencies),
		).resolves.toEqual({
			libraryId: "library-1",
			scannedFiles: 0,
			createdFiles: 0,
			existingFiles: 0,
			failedFiles: 0,
			analyzedFiles: 0,
		});

		expect(events).toEqual([
			"started",
			"scan:movie:/media",
			// initial checkpoint, then one after each enqueue list completes
			"checkpoint",
			"checkpoint",
			"checkpoint",
			"checkpoint-cleared",
			"completed:errors=0",
			"notified:library-1:Movies",
		]);
	});

	test("resumes an interrupted scan from its checkpoint without re-walking", async () => {
		const { dependencies, events, checkpoints, ingested } = createHarness();
		checkpoints.set("library-1", {
			pathsSignature: "/media",
			scannedFiles: 3,
			newFilePaths: ["/media/a.mkv", "/media/b.mkv", "/media/c.mkv"],
			changedMediaFileIds: [],
			ingestCursor: 1,
			refreshCursor: 0,
		});

		await expect(
			scanLibraryTask({ libraryId: "library-1", paths: ["/media"] }, { correlationId: "scan-2" }, dependencies),
		).resolves.toEqual({
			libraryId: "library-1",
			scannedFiles: 3,
			createdFiles: 3,
			existingFiles: 0,
			failedFiles: 0,
			analyzedFiles: 0,
		});

		// No "scan:" event — the interrupted enqueue phase finishes from the checkpoint.
		expect(ingested).toEqual(["/media/b.mkv", "/media/c.mkv"]);
		expect(events).toEqual([
			"started",
			"checkpoint",
			"checkpoint",
			"checkpoint-cleared",
			"completed:errors=0",
			"notified:library-1:Movies",
		]);
	});

	test("an abort mid-enqueue keeps the checkpoint; the next scan resumes it", async () => {
		const first = createHarness({
			scanResult: {
				filePaths: ["/media/a", "/media/b", "/media/c"],
				newFilePaths: ["/media/a", "/media/b", "/media/c"],
				changedMediaFileIds: [],
			},
			failIngestAt: 1,
		});

		await expect(
			scanLibraryTask({ libraryId: "library-1", paths: ["/media"] }, { correlationId: "scan-3" }, first.dependencies),
		).rejects.toThrow("aborted mid-enqueue");
		expect(first.events).toContain("completed:errors=1");
		// Checkpoint survived the abort — the interrupted enqueue phase is resumable.
		// (The per-item path checkpoints after the whole list, so the cursor is the
		// initial one; the batch path advances it per 500-file chunk.)
		const survived = first.checkpoints.get("library-1");
		expect(survived?.pathsSignature).toBe("/media");
		expect(survived?.newFilePaths).toEqual(["/media/a", "/media/b", "/media/c"]);

		// A stale checkpoint for different paths is dropped, not resumed.
		const second = createHarness({
			scanResult: { filePaths: ["/movies/x"], newFilePaths: ["/movies/x"], changedMediaFileIds: [] },
		});
		second.checkpoints.set("library-1", {
			pathsSignature: "/media",
			scannedFiles: 3,
			newFilePaths: ["/media/a", "/media/b", "/media/c"],
			changedMediaFileIds: [],
			ingestCursor: 1,
			refreshCursor: 0,
		});
		await scanLibraryTask({ libraryId: "library-1", paths: ["/movies"] }, { correlationId: "scan-4" }, second.dependencies);
		expect(second.ingested).toEqual(["/movies/x"]);
		expect(second.checkpoints.has("library-1")).toBe(false);
	});
});

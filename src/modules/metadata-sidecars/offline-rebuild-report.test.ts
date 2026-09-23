import { describe, expect, test } from "bun:test";
import type { CatalogImportResult, OfflineRebuildIssue, OfflineRebuildReport } from "./offline-rebuild-report";

describe("offline rebuild report shapes", () => {
	test("reports imported counters and skipped issues", () => {
		const skipped: OfflineRebuildIssue = { path: "/media/Movie/movie.nfo", reason: "unsupported or invalid movie sidecar" };
		const report: OfflineRebuildReport = { importedMovies: 1, importedMediaFiles: 2, skipped: [skipped] };
		const importResult: CatalogImportResult = { entries: 1, mediaFiles: 2 };

		expect(report.skipped[0]?.reason).toBe("unsupported or invalid movie sidecar");
		expect(report.importedMovies).toBe(importResult.entries);
		expect(report.importedMediaFiles).toBe(importResult.mediaFiles);
	});
});

import { describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import type { MediaFileAuditRow } from "@/database/repositories/media-files.repository";
import { auditMediaFileRow } from "./media-file-audit";

function createRow(overrides: Partial<MediaFileAuditRow> = {}): MediaFileAuditRow {
	return {
		mediaFileId: "file-1",
		fileName: "Alien (1979).mkv",
		filePath: "/media/movies/Alien (1979)/Alien (1979).mkv",
		libraryId: "lib-1",
		libraryName: "Movies",
		libraryType: "movie",
		metadataId: "meta-1",
		metadataTitle: "Alien",
		metadataOriginalTitle: null,
		metadataReleaseDate: "1979-05-25",
		metadataMatchScore: 1,
		metadataType: "movie",
		episodeNumber: null,
		seasonNumber: null,
		...overrides,
	};
}

describe("auditMediaFileRow", () => {
	test("does not flag a clean file", () => {
		expect(auditMediaFileRow(createRow())).toBeNull();
	});

	test("flags matches scoring below metadata.minMatchScore as low confidence", () => {
		const suspect = auditMediaFileRow(createRow({ metadataMatchScore: 0.7 }));

		expect(suspect?.reasons).toEqual([{ code: "low_confidence", severity: "low", params: { percent: 70 } }]);
	});

	test("keeps a match at or above the configured threshold clean", () => {
		expect(auditMediaFileRow(createRow({ metadataMatchScore: 0.8 }))).toBeNull();
	});

	test("reads the threshold from system settings", () => {
		systemSettingsStore.setRuntimeValue("metadata.minMatchScore", 0.45);
		try {
			expect(auditMediaFileRow(createRow({ metadataMatchScore: 0.6 }))).toBeNull();
		} finally {
			systemSettingsStore.setRuntimeValue("metadata.minMatchScore", 0.75);
		}
	});

	test("reports year mismatches from the assigned release date", () => {
		const high = auditMediaFileRow(createRow({ metadataReleaseDate: "1969-01-01" }));
		expect(high?.reasons).toEqual([
			{ code: "year_mismatch", severity: "high", params: { recognizedYear: 1979, assignedYear: 1969, diff: 10 } },
		]);

		const medium = auditMediaFileRow(createRow({ metadataReleaseDate: "1981-01-01" }));
		expect(medium?.reasons).toEqual([
			{ code: "year_mismatch", severity: "medium", params: { recognizedYear: 1979, assignedYear: 1981, diff: 2 } },
		]);
	});
});

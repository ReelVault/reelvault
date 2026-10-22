import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import type { MediaFileAuditRow } from "@/repositories/media-files.repository";
import { auditMediaFileRow } from "./media-file-audit.utils";

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

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

describe("auditMediaFileRow", () => {
	test("does not flag a clean file", () => {
		expect(auditMediaFileRow(createRow())).toBeNull();
	});

	test("flags a match just below the review level as low confidence", () => {
		const suspect = auditMediaFileRow(createRow({ metadataMatchScore: 0.74 }));

		expect(suspect?.reasons).toEqual([{ code: "low_confidence", severity: "low", params: { percent: 74 } }]);
	});

	test("keeps a match at the review level clean", () => {
		expect(auditMediaFileRow(createRow({ metadataMatchScore: 0.75 }))).toBeNull();
	});

	test("the acceptance setting does not move the low confidence review level", () => {
		systemSettingsStore.setRuntimeValue("metadata.minMatchScore", 0.7);

		expect(auditMediaFileRow(createRow({ metadataMatchScore: 0.72 }))?.reasons).toEqual([
			{ code: "low_confidence", severity: "low", params: { percent: 72 } },
		]);
	});

	test("does not flag a one-year release drift", () => {
		expect(auditMediaFileRow(createRow({ metadataReleaseDate: "1978-01-01" }))).toBeNull();
	});

	test.each([
		{ assignedYear: 1977, diff: 2, severity: "medium" },
		{ assignedYear: 1976, diff: 3, severity: "high" },
	] as const)("reports a $diff-year release drift as $severity", ({ assignedYear, diff, severity }) => {
		const suspect = auditMediaFileRow(createRow({ metadataReleaseDate: `${assignedYear}-01-01` }));

		expect(suspect?.reasons).toEqual([{ code: "year_mismatch", severity, params: { recognizedYear: 1979, assignedYear, diff } }]);
	});
});

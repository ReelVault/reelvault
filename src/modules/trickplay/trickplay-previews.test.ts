import { describe, expect, test } from "bun:test";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { trickplayAdminService } from "@/app/trickplay/trickplay-admin.service";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";

// Trickplay previews are stored artifacts; the counts and the removal are read back from them.
const db = useTestDatabase();

async function seedPreviews(): Promise<{ fileA: string; fileB: string }> {
	const fileA = await insertMovieMediaFile(db.client(), "/movies/a.mkv", "m-a");
	const fileB = await insertMovieMediaFile(db.client(), "/movies/b.mkv", "m-b");
	for (let index = 0; index < 2; index++) {
		await mediaArtifactsService.write(CORE_ARTIFACTS_OWNER, {
			mediaFileId: fileA,
			kind: "trickplay",
			contentType: "image/webp",
			content: new TextEncoder().encode(`sprite-${index}`),
		});
	}

	return { fileA, fileB };
}

async function previewCount(mediaFileId: string): Promise<number> {
	const artifacts = await mediaArtifactsService.list(mediaFileId);

	return artifacts.filter((artifact) => artifact.kind === "trickplay").length;
}

describe("trickplayAdminService.deletePreviews", () => {
	test("a dry run counts the previews it would remove and removes none", async () => {
		const { fileA, fileB } = await seedPreviews();

		expect(await trickplayAdminService.deletePreviews([fileA, fileB, fileA], { dryRun: true })).toEqual({ mediaFiles: 1, artifacts: 2 });
		expect(await previewCount(fileA)).toBe(2);
	});

	test("removes the core previews of each distinct file and counts the files that had some", async () => {
		const { fileA, fileB } = await seedPreviews();

		expect(await trickplayAdminService.deletePreviews([fileA, fileB, fileA])).toEqual({ mediaFiles: 1, artifacts: 2 });
		expect(await previewCount(fileA)).toBe(0);
		expect(await previewCount(fileB)).toBe(0);
	});
});

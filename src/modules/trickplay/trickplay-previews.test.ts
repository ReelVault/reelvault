import { describe, expect, test } from "bun:test";
import { CORE_ARTIFACTS_OWNER } from "@/modules/artifacts/artifacts.constants";
import { mediaArtifactsService } from "@/modules/artifacts/media-artifacts.service";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import { stubMethod } from "../../../tests/helpers/method-stub";

describe("trickplayService.deletePreviews", () => {
	test("a dry run counts the previews it would remove and removes none", async () => {
		const counted = stubMethod(mediaArtifactsService, "countByMediaFileIdAndKind", (mediaFileId: string) =>
			Promise.resolve(mediaFileId === "file-a" ? 2 : 0),
		);
		const removed = stubMethod(mediaArtifactsService, "deleteByMediaFileIdAndKind", () => Promise.resolve(0));

		try {
			const result = await trickplayService.deletePreviews(["file-a", "file-b"], { dryRun: true });

			expect(result).toEqual({ mediaFiles: 1, artifacts: 2 });
			expect(counted.calls).toEqual([
				["file-a", "trickplay", CORE_ARTIFACTS_OWNER],
				["file-b", "trickplay", CORE_ARTIFACTS_OWNER],
			]);
			expect(removed.calls).toEqual([]);
		} finally {
			counted.restore();
			removed.restore();
		}
	});

	test("removes the core previews of each distinct file and counts the files that had some", async () => {
		const removed = stubMethod(mediaArtifactsService, "deleteByMediaFileIdAndKind", (mediaFileId: string) =>
			Promise.resolve(mediaFileId === "file-a" ? 2 : 0),
		);

		try {
			const result = await trickplayService.deletePreviews(["file-a", "file-b", "file-a"]);

			expect(result).toEqual({ mediaFiles: 1, artifacts: 2 });
			expect(removed.calls).toEqual([
				["file-a", "trickplay", CORE_ARTIFACTS_OWNER],
				["file-b", "trickplay", CORE_ARTIFACTS_OWNER],
			]);
		} finally {
			removed.restore();
		}
	});
});

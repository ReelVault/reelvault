import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { truncate } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { mediaArtifactsRepository } from "@/app/repositories/media-artifacts.repository";
import { trickplayRepository } from "@/app/repositories/trickplay.repository";
import { trickplayAdminService } from "@/app/trickplay/trickplay-admin.service";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { PathUtils } from "@/utils/path.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { trickplayService } from "./trickplay.service";

// Media files, artifacts, budget settings and the stats cache run against the migrated test database,
// and the artifacts are real files under the test root. Stubbed: ffmpeg, a process boundary. The stub
// writes the output file named in the command, so the artifact store records real sprites.
const db = useTestDatabase();
const GIBIBYTE = 1024 * 1024 * 1024;
const SPRITE_BYTES = 200;
const DURATION_SECONDS = 600;
const activeStubs: Array<{ restore(): void }> = [];
let ffmpegCommands: string[][] = [];
let failOnCall = 0;

beforeEach(() => {
	mediaArtifactsService.invalidateByteTotals();
	trickplayRepository.clearStatsCache();
	ffmpegCommands = [];
	failOnCall = 0;
	activeStubs.push(
		stubMethod(ffMpegService, "runToCompletion", async (args: string[]) => {
			ffmpegCommands.push(args);
			if (ffmpegCommands.length === failOnCall) return { exitCode: 1, stderr: "stub failure" };

			const outputPath = args.at(-1);
			if (!outputPath) throw new Error("The ffmpeg command has no output path");
			await Bun.write(outputPath, new Uint8Array(SPRITE_BYTES));

			return { exitCode: 0, stderr: "" };
		}),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	systemSettingsStore.deleteRuntimeValues(["trickplay.enabled", "system.artifacts.coreMaxStorageGb"]);
});

async function seedMediaFile(name: string, duration: number | null): Promise<string> {
	const mediaFileId = await insertMovieMediaFile(db.client(), `/media/${name}.mkv`, `metadata-${name}`);
	await db.client().update(schema.mediaFiles).set({ duration }).where(eq(schema.mediaFiles.id, mediaFileId));

	return mediaFileId;
}

function storedArtifacts(mediaFileId: string) {
	return mediaArtifactsService.list(mediaFileId);
}

/** Stores a trickplay artifact of `bytes`: a small write, stretched with a sparse truncate so storage totals see the size without writing it. */
async function storeArtifactOfSize(mediaFileId: string, bytes: number): Promise<void> {
	const artifact = await mediaArtifactsService.write(CORE_ARTIFACTS_OWNER, {
		mediaFileId,
		kind: "trickplay",
		contentType: "image/webp",
		content: new Uint8Array(16),
	});
	const row = await mediaArtifactsRepository.findById(artifact.id);
	if (!row) throw new Error("Expected the artifact row to exist");

	await truncate(PathUtils.join(serverConfig.paths.artifacts, row.storageKey), bytes);
	mediaArtifactsService.invalidateByteTotals();
}

async function cueTrack(mediaFileId: string): Promise<string> {
	const cueTrackArtifact = (await storedArtifacts(mediaFileId)).find((artifact) => artifact.contentType === "text/vtt");
	if (!cueTrackArtifact) throw new Error("Expected a cue track artifact");

	const found = await mediaArtifactsService.findFile(mediaFileId, cueTrackArtifact.id);
	if (!found) throw new Error("Expected the cue track file");

	return await found.file.text();
}

describe("trickplayService.generateForMediaFile", () => {
	test("stores sprite sheets and a cue track for the file", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);

		const result = await trickplayService.generateForMediaFile(mediaFileId);

		// 600 s at a 10 s interval is 60 frames; 25 tiles fit a sprite, so 3 sprites.
		expect(result).toEqual({ mediaFileId, frames: 60, sprites: 3 });
		const artifacts = await storedArtifacts(mediaFileId);
		expect(artifacts.filter((artifact) => artifact.contentType === "image/webp")).toHaveLength(3);
		expect(artifacts.filter((artifact) => artifact.contentType === "text/vtt")).toHaveLength(1);
	});

	test("the cue track points each interval at its tile in its sprite", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		await trickplayService.generateForMediaFile(mediaFileId);

		const cues = (await cueTrack(mediaFileId)).split("\n\n").slice(1);
		expect(cues).toHaveLength(60);
		const [firstTiming, firstPayload] = (cues[0] ?? "").split("\n");
		expect(firstTiming).toBe("00:00:00.000 --> 00:00:10.000");
		expect(firstPayload).toEndWith("#xywh=0,0,320,180");
		const firstUrl = firstPayload?.split("#xywh=")[0];
		// Frame 5 is the second row of the first sprite; frame 25 starts the second sprite.
		expect(cues[5]?.split("\n")[1]).toEndWith("#xywh=0,180,320,180");
		expect(cues[25]?.split("\n")[1]?.split("#xywh=")[0]).not.toBe(firstUrl);
	});

	test("samples the middle of each interval", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);

		await trickplayService.generateForMediaFile(mediaFileId);

		const firstCommand = ffmpegCommands[0] ?? [];
		expect(firstCommand[firstCommand.indexOf("-ss") + 1]).toBe("5.000");
	});

	test("a regeneration replaces the previous sprites rather than adding to them", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		await trickplayService.generateForMediaFile(mediaFileId);
		const previousIds = (await storedArtifacts(mediaFileId)).map((artifact) => artifact.id);

		await trickplayService.generateForMediaFile(mediaFileId);

		const currentIds = (await storedArtifacts(mediaFileId)).map((artifact) => artifact.id);
		expect(currentIds).toHaveLength(4);
		const previous = new Set(previousIds);
		expect(currentIds.some((id) => previous.has(id))).toBe(false);
	});

	test("skips without deleting existing artifacts when core storage is over budget", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		const otherFileId = await seedMediaFile("other", DURATION_SECONDS);
		await trickplayService.generateForMediaFile(mediaFileId);
		const existingIds = (await storedArtifacts(mediaFileId)).map((artifact) => artifact.id).toSorted((a, b) => a.localeCompare(b));
		const commandsBefore = ffmpegCommands.length;
		// The budget is 1 GiB. Another file's artifact fills all of it, so this file's own bytes cannot make room.
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);
		await storeArtifactOfSize(otherFileId, GIBIBYTE);

		const result = await trickplayService.generateForMediaFile(mediaFileId);

		expect(result).toEqual({ mediaFileId, frames: 0, sprites: 0, skipped: "storage-budget" });
		expect((await storedArtifacts(mediaFileId)).map((artifact) => artifact.id).toSorted((a, b) => a.localeCompare(b))).toEqual(existingIds);
		expect(ffmpegCommands).toHaveLength(commandsBefore);
	});

	test("still regenerates when dropping this file's own artifacts fits the budget", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);
		// This file's own previous sprites fill the budget, so regenerating them frees the room it needs.
		await storeArtifactOfSize(mediaFileId, GIBIBYTE + 1);

		const result = await trickplayService.generateForMediaFile(mediaFileId);

		expect(result).toEqual({ mediaFileId, frames: 60, sprites: 3 });
		expect(await storedArtifacts(mediaFileId)).toHaveLength(4);
	});
});

describe("trickplayService.generateForMediaFile: failures and skips", () => {
	test("a failed regeneration leaves no sprites or cue track behind", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		await trickplayService.generateForMediaFile(mediaFileId);
		// The next run's first sprite succeeds and its second fails, so a sprite is already stored when it fails.
		failOnCall = ffmpegCommands.length + 2;

		await expect(trickplayService.generateForMediaFile(mediaFileId)).rejects.toMatchObject({
			code: "trickplay_extraction_failed",
		});
		expect(await storedArtifacts(mediaFileId)).toEqual([]);
	});

	test("a budget refusal in the middle of generation skips the file instead of failing it", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		const otherFileId = await seedMediaFile("other", DURATION_SECONDS);
		// Just under the budget: the pre-check passes, but the first sprite pushes the total over it.
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);
		await storeArtifactOfSize(otherFileId, GIBIBYTE - SPRITE_BYTES / 2);

		const result = await trickplayService.generateForMediaFile(mediaFileId);

		expect(result).toEqual({ mediaFileId, frames: 0, sprites: 0, skipped: "storage-budget" });
		expect(await storedArtifacts(mediaFileId)).toEqual([]);
	});

	test("skips a file without duration and runs no extraction", async () => {
		const mediaFileId = await seedMediaFile("silent", null);

		await expect(trickplayService.generateForMediaFile(mediaFileId)).resolves.toEqual({
			mediaFileId,
			frames: 0,
			sprites: 0,
			skipped: "no-duration",
		});
		expect(ffmpegCommands).toEqual([]);
	});

	test("skips and stores nothing when trickplay is switched off", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		systemSettingsStore.setRuntimeValue("trickplay.enabled", false);

		await expect(trickplayService.generateForMediaFile(mediaFileId)).resolves.toEqual({
			mediaFileId,
			frames: 0,
			sprites: 0,
			skipped: "disabled",
		});
		expect(ffmpegCommands).toEqual([]);
	});

	test("refuses a media file that is not in the library", async () => {
		await expect(trickplayService.generateForMediaFile("missing")).rejects.toMatchObject({ code: "media_file_not_found" });
	});
});

describe("trickplayAdminService.stats", () => {
	test("returns coverage counts, stored bytes and the configured budget", async () => {
		const withPreviews = await seedMediaFile("with", DURATION_SECONDS);
		await seedMediaFile("without", DURATION_SECONDS);
		await seedMediaFile("unknown-length", null);
		await trickplayService.generateForMediaFile(withPreviews);
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 2);

		const stats = await trickplayAdminService.stats();

		// A file without a duration is not part of the catalog total.
		expect(stats).toMatchObject({ total: 2, withTrickplay: 1, missingTrickplay: 1, storageBudgetBytes: 2 * GIBIBYTE });
		const sizes = await Promise.all(
			(await storedArtifacts(withPreviews)).map((artifact) => mediaArtifactsService.findFile(withPreviews, artifact.id)),
		);
		expect(stats.storageBytes).toBe(sizes.reduce((total, found) => total + (found?.file.size ?? 0), 0));
	});
});

describe("trickplayAdminService.deletePreviews", () => {
	test("a dry run counts the previews without removing them", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		await trickplayService.generateForMediaFile(mediaFileId);

		await expect(trickplayAdminService.deletePreviews([mediaFileId], { dryRun: true })).resolves.toEqual({ mediaFiles: 1, artifacts: 4 });
		expect(await storedArtifacts(mediaFileId)).toHaveLength(4);
	});

	test("removes a file's previews once even when it is named twice, and the stats follow", async () => {
		const mediaFileId = await seedMediaFile("movie", DURATION_SECONDS);
		await trickplayService.generateForMediaFile(mediaFileId);
		// Read the stats first so the cached counts exist; the deletion must clear them.
		expect((await trickplayAdminService.stats()).withTrickplay).toBe(1);

		await expect(trickplayAdminService.deletePreviews([mediaFileId, mediaFileId])).resolves.toEqual({ mediaFiles: 1, artifacts: 4 });
		expect(await storedArtifacts(mediaFileId)).toEqual([]);
		expect((await trickplayAdminService.stats()).withTrickplay).toBe(0);
	});

	test("a file without previews, or an unknown id, counts as nothing removed", async () => {
		const withoutPreviews = await seedMediaFile("without", DURATION_SECONDS);

		await expect(trickplayAdminService.deletePreviews(["missing", withoutPreviews])).resolves.toEqual({ mediaFiles: 0, artifacts: 0 });
	});
});

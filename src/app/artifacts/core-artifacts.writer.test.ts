import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { truncate } from "node:fs/promises";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { mediaArtifactsRepository } from "../repositories/media-artifacts.repository";
import { writeCoreArtifact } from "./core-artifacts.writer";
import { mediaArtifactsService } from "./media-artifacts.service";

// Artifact rows and files live in the test database and test root. The settings store is process-wide.
const db = useTestDatabase();
const GIBIBYTE = 1024 * 1024 * 1024;

beforeEach(() => {
	mediaArtifactsService.invalidateByteTotals();
});

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

describe("writeCoreArtifact", () => {
	test("stores the artifact under the core owner when it fits the budget", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), "/media/core.mkv", "metadata-core");
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);

		const artifact = await writeCoreArtifact({
			mediaFileId,
			kind: "trickplay",
			contentType: "text/vtt",
			content: new TextEncoder().encode("WEBVTT"),
		});

		expect((await mediaArtifactsRepository.findById(artifact.id))?.pluginId).toBe(CORE_ARTIFACTS_OWNER);
	});

	test("refuses an artifact that would exceed the core budget and stores nothing", async () => {
		const fullFileId = await insertMovieMediaFile(db.client(), "/media/full.mkv", "metadata-full");
		const mediaFileId = await insertMovieMediaFile(db.client(), "/media/new.mkv", "metadata-new");
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);
		const full = await writeCoreArtifact({
			mediaFileId: fullFileId,
			kind: "trickplay",
			contentType: "text/vtt",
			content: new TextEncoder().encode("WEBVTT"),
		});
		// A sparse truncate makes the stored file the size of the whole budget without writing a gigabyte.
		const fullRow = await mediaArtifactsRepository.findById(full.id);
		if (!fullRow) throw new Error("Expected the artifact row to exist");
		await truncate(join(serverConfig.paths.artifacts, fullRow.storageKey), GIBIBYTE);
		mediaArtifactsService.invalidateByteTotals();

		await expect(
			writeCoreArtifact({
				mediaFileId,
				kind: "trickplay",
				contentType: "text/vtt",
				content: new TextEncoder().encode("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "artifact.storage_budget_exceeded" });
		expect(await mediaArtifactsService.list(mediaFileId)).toEqual([]);
	});
});

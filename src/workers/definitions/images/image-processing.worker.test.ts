import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serverConfig } from "@/config/server/server.config";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { enqueueImageProcessing, imageProcessingWorker, processImageTask } from "./image-processing.worker";

// The enqueue test reads the queued row back from the migrated test database.
useTestDatabase();

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	workerService.registry.register(imageProcessingWorker);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	workerService.registry.unregister(imageProcessingWorker.id);
});

describe("image-processing worker", () => {
	test("processes image targets through one task per entity type", async () => {
		const calls: string[] = [];
		activeStubs.push(
			stubMethod(imageProcessingService, "processMetadata", () => {
				calls.push("metadata");

				return Promise.resolve(undefined);
			}),
			stubMethod(imageProcessingService, "processPerson", () => {
				calls.push("person");

				return Promise.resolve(undefined);
			}),
			stubMethod(imageProcessingService, "processSeason", (input: { seasonId: string }) => {
				calls.push(`season:${input.seasonId}`);

				return Promise.resolve(undefined);
			}),
			stubMethod(imageProcessingService, "processEpisode", (input: { episodeId: string }) => {
				calls.push(`episode:${input.episodeId}`);

				return Promise.resolve(undefined);
			}),
		);

		await expect(processImageTask({ kind: "person", personId: "person-1", urls: "url" })).resolves.toEqual({
			entityType: "person",
			entityId: "person-1",
		});
		await expect(processImageTask({ kind: "metadata", metadataId: "metadata-1", urls: [] })).resolves.toEqual({
			entityType: "metadata",
			entityId: "metadata-1",
		});
		await expect(
			processImageTask({ kind: "season", metadataId: "metadata-1", seasonId: "season-1", seasonNumber: "2", urls: "url" }),
		).resolves.toEqual({ entityType: "season", entityId: "season-1" });
		await expect(
			processImageTask({
				kind: "episode",
				metadataId: "metadata-1",
				episodeId: "episode-1",
				seasonNumber: "2",
				episodeNumber: "3",
				urls: "url",
			}),
		).resolves.toEqual({ entityType: "episode", entityId: "episode-1" });

		expect(calls).toEqual(["person", "metadata", "season:season-1", "episode:episode-1"]);
	});

	test("enqueues each entity under its own dedupe key, reference and configured priority", async () => {
		const priorities = serverConfig.workers.definitions.imageProcessing.priorities;

		const season = await enqueueImageProcessing({
			kind: "season",
			metadataId: "metadata-1",
			seasonId: "season-1",
			seasonNumber: "2",
			urls: "url",
		});
		const person = await enqueueImageProcessing({ kind: "person", personId: "person-1", urls: "url" });

		expect(season).toMatchObject({
			workerId: imageProcessingWorker.id,
			dedupeKey: "image-processing_season:season-1",
			referenceType: "season",
			referenceId: "season-1",
			priority: priorities.season,
		});
		expect(person).toMatchObject({
			workerId: imageProcessingWorker.id,
			dedupeKey: "image-processing_person:person-1",
			referenceType: "person",
			referenceId: "person-1",
			priority: priorities.person,
		});
	});
});

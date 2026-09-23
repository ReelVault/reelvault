import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serverConfig } from "@/server.config";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { enqueueImageProcessing, type ImageProcessingTaskDependencies, processImageTask } from "./image-processing.worker";

describe("image-processing worker", () => {
	let restoreAddItem: (() => void) | undefined;

	beforeEach(async () => {
		const { workerService } = await import("@/workers/worker.service");
		const original = Reflect.get(workerService, "addItem");
		Reflect.set(workerService, "addItem", () => Promise.resolve(createMockWorkerItem({ workerId: "image-processing" })));
		restoreAddItem = () => {
			Reflect.set(workerService, "addItem", original);
		};
	});

	afterEach(() => {
		restoreAddItem?.();
		restoreAddItem = undefined;
	});

	test("processes image targets through one task per entity type", async () => {
		const calls: string[] = [];
		const dependencies: ImageProcessingTaskDependencies = {
			processMetadata: async () => calls.push("metadata"),
			processPerson: async () => calls.push("person"),
			processSeason: async ({ seasonId }) => calls.push(`season:${seasonId}`),
			processEpisode: async ({ episodeId }) => calls.push(`episode:${episodeId}`),
		};

		await expect(processImageTask({ kind: "person", personId: "person-1", urls: "url" }, {}, dependencies)).resolves.toEqual({
			entityType: "person",
			entityId: "person-1",
		});
		await expect(processImageTask({ kind: "metadata", metadataId: "metadata-1", urls: [] }, {}, dependencies)).resolves.toEqual({
			entityType: "metadata",
			entityId: "metadata-1",
		});
		await expect(
			processImageTask(
				{ kind: "season", metadataId: "metadata-1", seasonId: "season-1", seasonNumber: "2", urls: "url" },
				{},
				dependencies,
			),
		).resolves.toEqual({ entityType: "season", entityId: "season-1" });
		await expect(
			processImageTask(
				{ kind: "episode", metadataId: "metadata-1", episodeId: "episode-1", seasonNumber: "2", episodeNumber: "3", urls: "url" },
				{},
				dependencies,
			),
		).resolves.toEqual({ entityType: "episode", entityId: "episode-1" });

		expect(calls).toEqual(["person", "metadata", "season:season-1", "episode:episode-1"]);
	});

	test("enqueues with a per-entity dedupe key, reference and configured priority", async () => {
		const { workerService } = await import("@/workers/worker.service");
		const calls: Array<{
			workerId: string;
			data: unknown;
			options: { dedupeKey?: string; reference?: { type: string; id: string }; priority?: number };
		}> = [];
		const original = Reflect.get(workerService, "addItem");
		Reflect.set(
			workerService,
			"addItem",
			(workerId: string, data: unknown, options: { dedupeKey?: string; reference?: { type: string; id: string }; priority?: number }) => {
				calls.push({ workerId, data, options });

				return Promise.resolve(createMockWorkerItem({ workerId }));
			},
		);
		restoreAddItem = () => {
			Reflect.set(workerService, "addItem", original);
		};

		await enqueueImageProcessing({ kind: "season", metadataId: "metadata-1", seasonId: "season-1", seasonNumber: "2", urls: "url" });
		await enqueueImageProcessing({ kind: "person", personId: "person-1", urls: "url" });

		const priorities = serverConfig.workers.definitions.imageProcessing.priorities;
		expect(calls.map((call) => call.workerId)).toEqual(["image-processing", "image-processing"]);
		expect(calls[0]?.options).toEqual({
			dedupeKey: "image-processing_season:season-1",
			reference: { type: "season", id: "season-1" },
			priority: priorities.season,
		});
		expect(calls[1]?.options).toEqual({
			dedupeKey: "image-processing_person:person-1",
			reference: { type: "person", id: "person-1" },
			priority: priorities.person,
		});
	});
});

import { beforeEach, describe, expect, test } from "bun:test";
import type { DownloadStatus } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { downloadsRepository } from "./downloads.repository";

const db = useTestDatabase();
let mediaFileId = "";

beforeEach(async () => {
	const client = db.client();
	await client.insert(schema.users).values({ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });
	await client.insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Ann" });
	mediaFileId = await insertMovieMediaFile(client, "/media/movie.mkv");
});

async function insertDownload(id: string, status: DownloadStatus): Promise<void> {
	await db.client().insert(schema.downloads).values({ id, profileId: "profile-1", mediaFileId, status });
}

describe("downloadsRepository terminal transitions", () => {
	test("completes only a processing download", async () => {
		await insertDownload("dl-processing", "processing");
		await insertDownload("dl-cancelled", "cancelled");

		expect(await downloadsRepository.completeProcessing("dl-processing", 11)).toBe(true);
		expect(await downloadsRepository.completeProcessing("dl-cancelled", 11)).toBe(false);

		expect(await downloadsRepository.findById("dl-processing")).toMatchObject({
			status: "completed",
			progressPercent: 100,
			sizeBytes: 11,
		});
		expect(await downloadsRepository.findById("dl-cancelled")).toMatchObject({ status: "cancelled", sizeBytes: null });
	});

	test("fails only a pending or processing download", async () => {
		await insertDownload("dl-pending", "pending");
		await insertDownload("dl-processing", "processing");
		await insertDownload("dl-completed", "completed");
		await insertDownload("dl-cancelled", "cancelled");

		expect(await downloadsRepository.failIfActive("dl-pending", "download.ffmpeg_failed")).toBe(true);
		expect(await downloadsRepository.failIfActive("dl-processing", "download.ffmpeg_failed")).toBe(true);
		expect(await downloadsRepository.failIfActive("dl-completed", "download.ffmpeg_failed")).toBe(false);
		expect(await downloadsRepository.failIfActive("dl-cancelled", "download.ffmpeg_failed")).toBe(false);

		expect(await downloadsRepository.findById("dl-pending")).toMatchObject({
			status: "failed",
			errorText: "download.ffmpeg_failed",
		});
		expect(await downloadsRepository.findById("dl-processing")).toMatchObject({
			status: "failed",
			errorText: "download.ffmpeg_failed",
		});
		expect(await downloadsRepository.findById("dl-completed")).toMatchObject({ status: "completed", errorText: null });
		expect(await downloadsRepository.findById("dl-cancelled")).toMatchObject({ status: "cancelled", errorText: null });
	});

	test("cancels any row that has not completed, including one already cancelled", async () => {
		await insertDownload("dl-pending", "pending");
		await insertDownload("dl-cancelled", "cancelled");
		await insertDownload("dl-completed", "completed");

		expect(await downloadsRepository.cancelIfNotCompleted("dl-pending")).toMatchObject({ id: "dl-pending", status: "cancelled" });
		expect(await downloadsRepository.cancelIfNotCompleted("dl-cancelled")).toMatchObject({ id: "dl-cancelled", status: "cancelled" });
		expect(await downloadsRepository.cancelIfNotCompleted("dl-completed")).toBeNull();

		expect(await downloadsRepository.findById("dl-pending")).toMatchObject({ status: "cancelled" });
		expect(await downloadsRepository.findById("dl-completed")).toMatchObject({ status: "completed" });
	});

	test("requeues a pending download as well as a processing one", async () => {
		await insertDownload("dl-pending", "pending");
		await insertDownload("dl-processing", "processing");
		await insertDownload("dl-cancelled", "cancelled");

		expect(await downloadsRepository.requeueIfActive("dl-pending")).toBe(true);
		expect(await downloadsRepository.requeueIfActive("dl-processing")).toBe(true);
		expect(await downloadsRepository.requeueIfActive("dl-cancelled")).toBe(false);

		expect(await downloadsRepository.findById("dl-pending")).toMatchObject({ status: "pending", errorText: null });
		expect(await downloadsRepository.findById("dl-processing")).toMatchObject({ status: "pending", errorText: null });
		expect(await downloadsRepository.findById("dl-cancelled")).toMatchObject({ status: "cancelled" });
	});
});

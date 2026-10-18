import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { SeekService } from "./seek.service";

const db = useTestDatabase();

/** The duration comes from a real media row. The live transcode session stays behind the injected seams. */
async function seedMediaFile(duration: number | null): Promise<string> {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, "/media/seek.mkv", "movie-seek");
	await client.update(schema.mediaFiles).set({ duration }).where(eq(schema.mediaFiles.id, mediaFileId));

	return mediaFileId;
}

async function createService(options: { duration?: number | null; hasDecision?: boolean } = {}) {
	const mediaFileId = await seedMediaFile(options.duration === undefined ? 600 : options.duration);
	const seekCalls: Array<{ sessionId: string; position: number }> = [];
	const service = new SeekService({
		requireSession: () => ({ mediaFileId, profileId: "profile-1" }),
		findForStreamingDuration: (fileId) => mediaRepository.findForStreamingDuration(fileId),
		getSessionDecision: () => (options.hasDecision === false ? undefined : createMockPlaybackDecision({ mode: "transcode" })),
		seekTo: (sessionId: string, position: number) => {
			seekCalls.push({ sessionId, position });

			return Promise.resolve({ startTime: position, reusedBuffer: false });
		},
	});

	return { service, seekCalls };
}

describe("seek service", () => {
	test("executes a seek at the requested position", async () => {
		const { service, seekCalls } = await createService();

		const result = await service.seek("s1", 120);

		expect(result).toEqual({ position: 120, startTime: 120, reusedBuffer: false });
		expect(seekCalls).toEqual([{ sessionId: "s1", position: 120 }]);
	});

	test("collapses missing and non-finite positions to 0", async () => {
		const { service, seekCalls } = await createService();

		expect((await service.seek("s1", null)).position).toBe(0);
		expect((await service.seek("s1", Number.NaN)).position).toBe(0);
		expect((await service.seek("s1", Number.POSITIVE_INFINITY)).position).toBe(0);
		expect(seekCalls.every((call) => call.position === 0)).toBe(true);
	});

	test("clamps the reported position before the EOF guard and forwards the raw position", async () => {
		const { service, seekCalls } = await createService({ duration: 600 });

		const result = await service.seek("s1", 599.5);

		// EOF guard = 1s: the maximum reported position is 599; SessionSeeker
		// applies the clamp to the raw position it receives.
		expect(result.position).toBe(599);
		expect(seekCalls[0]?.position).toBe(599.5);
	});

	test("keeps the raw position when the duration is unknown", async () => {
		const { service } = await createService({ duration: null });

		expect((await service.seek("s1", 42)).position).toBe(42);
	});

	test("reports negative positions as zero and forwards the raw position", async () => {
		const { service, seekCalls } = await createService();

		expect((await service.seek("s1", -10)).position).toBe(0);
		// SessionSeeker owns flooring negative offsets.
		expect(seekCalls[0]?.position).toBe(-10);
	});

	test("fails when the session has no decision yet", async () => {
		const { service } = await createService({ hasDecision: false });

		await expect(service.seek("s1", 10)).rejects.toMatchObject({ code: "stream.not_ready" });
	});
});

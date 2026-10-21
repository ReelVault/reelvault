import { afterAll, describe, expect, test } from "bun:test";
import type { CreatePlaybackSession } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { profilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { systemSettingsStore } from "@/config/system-settings.store";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { SOFTWARE_HWACCEL } from "@/integrations/ffmpeg/capabilities/hwaccel.utils";
import { workerService } from "@/workers/worker.service";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { type ServiceDependencies, SessionLifecycleService } from "./session-lifecycle.service";

// The software-transcode cap only applies when no hardware encoder is
// available. The real capabilities are probed once per process, so without
// this pin the test would depend on the host's GPU and on whether another
// test file initialized them first.
mockModuleWithRealExports("@/integrations/ffmpeg/ffmpeg.capabilities", {
	getEffectiveHwaccel: () => SOFTWARE_HWACCEL,
});

afterAll(() => {
	restoreModuleMocks();
});

const db = useTestDatabase();

async function seedViewer(): Promise<void> {
	const client = db.client();
	await client.insert(schema.users).values({ id: "user-1", name: "Viewer", email: "viewer@example.com", emailVerified: true });
	await client.insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Default" });
}

/** A movie file with a video stream, two audio tracks and two external subtitles, read back through the real repositories. */
async function seedMovieFile(options: { metadataId?: string; filePath?: string; enabled?: boolean } = {}): Promise<string> {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, options.filePath ?? "/media/f.mkv", options.metadataId ?? "meta-1");
	await client
		.update(schema.mediaFiles)
		.set({ duration: 1200, bitRate: 5_000_000, formatName: "matroska", isEnabled: options.enabled ?? true })
		.where(eq(schema.mediaFiles.id, mediaFileId));
	await client.insert(schema.mediaFileVideoStreams).values({
		mediaFileId,
		index: 0,
		isDefault: true,
		codecName: "h264",
		profile: "high",
		width: 1920,
		height: 1080,
		pixelFormat: "yuv420p",
		frameRate: "24/1",
	});
	await client.insert(schema.mediaFileAudioStreams).values([
		{ mediaFileId, index: 1, isDefault: true, codecName: "aac", channels: 2, language: "pol" },
		{ mediaFileId, index: 2, isDefault: false, codecName: "ac3", channels: 6, language: "eng" },
	]);
	await client.insert(schema.subtitles).values([
		{ id: "sub-pl", mediaFileId, language: "pol", format: "srt", type: "external", filePath: "/media/f.pl.srt" },
		{ id: "sub-eng", mediaFileId, language: "eng", format: "srt", type: "external", filePath: "/media/f.eng.srt" },
	]);

	return mediaFileId;
}

/** A second file of the same title, the way another version of the movie is stored. */
async function seedOtherVersion(metadataId: string, filePath: string): Promise<string> {
	const client = db.client();
	const [sibling] = await client
		.select({ libraryId: schema.mediaFiles.libraryId, movieId: schema.mediaFiles.movieId })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.metadataId, metadataId))
		.limit(1);
	if (!sibling) throw new Error(`No media file for metadata ${metadataId}`);
	const [inserted] = await client
		.insert(schema.mediaFiles)
		.values({ libraryId: sibling.libraryId, metadataId, movieId: sibling.movieId, filePath, fileName: filePath.slice(1) })
		.returning({ id: schema.mediaFiles.id });
	if (!inserted) throw new Error("Expected the other version to be inserted");

	return inserted.id;
}

/**
 * The runtime owns the live ffmpeg processes and the session capacity, and the enqueue, plugin
 * publish and ffmpeg-availability checks cross the process boundary. Those are the seams here.
 */
function createService(
	options: {
		enqueueFails?: boolean;
		reserveFails?: boolean;
		terminatedByAdmin?: boolean;
		reserveResults?: boolean[];
		profileSessions?: Array<{ sessionId: string; mediaFileId: string }>;
		softwareTranscodeLimitReached?: boolean;
	} = {},
) {
	const calls = {
		registered: [] as string[],
		prepared: [] as string[],
		setOperations: [] as string[],
		releasedReservations: [] as string[],
		releasedSessions: [] as string[],
		discarded: [] as string[],
		published: [] as unknown[],
	};

	const dependencies: ServiceDependencies = {
		mediaRepository,
		profilePreferencesRepository,
		systemSettings: systemSettingsStore,
		workerService,
		enqueueStreamInit: (_data, enqueueOptions) => {
			if (options.enqueueFails) throw new Error("enqueue failed");

			return Promise.resolve({ operationId: enqueueOptions?.operationId ?? null });
		},
		runtime: {
			isProfileTerminatedRecently: () => (options.terminatedByAdmin ? { reason: "admin-stop" } : null),
			reserveSession: () => (options.reserveResults ? (options.reserveResults.shift() ?? true) : !options.reserveFails),
			tryReserveSoftwareTranscode: () => options.softwareTranscodeLimitReached !== true,
			releaseSoftwareTranscode: () => {
				// The mock never counts transcodes.
			},
			listSessionsForProfile: () => options.profileSessions ?? [],
			explainCapacityLimit: () => ({ scope: "server" as const, limit: 2, active: 2 }),
			registerSession: (sessionId: string) => {
				calls.registered.push(sessionId);
			},
			prepareSession: (sessionId: string) => {
				calls.prepared.push(sessionId);

				return Promise.resolve();
			},
			setSessionOperation: (_sessionId: string, operationId: string) => {
				calls.setOperations.push(operationId);
			},
			releaseSessionReservation: (sessionId: string) => {
				calls.releasedReservations.push(sessionId);
			},
			discardSession: (sessionId: string) => {
				calls.discarded.push(sessionId);

				return Promise.resolve();
			},
			getActiveSessions: () => 0,
			getSessionAccess: () => undefined,
			releaseSession: (sessionId: string) => {
				calls.releasedSessions.push(sessionId);

				return Promise.resolve("released" as const);
			},
			getTerminatedSession: () => undefined,
		},
		publisher: (event) => calls.published.push(event),
		assertEnvironment: () => "/usr/bin/ffmpeg",
	};

	return { service: new SessionLifecycleService(dependencies), calls };
}

const body: CreatePlaybackSession = { mediaFileId: "file-1" };

describe("session lifecycle service", () => {
	test("creates a session: reserves, prepares, enqueues and publishes", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const { service, calls } = createService();

		const session = await service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-1", "user-1");

		const operations = await db.client().select({ id: schema.workerOperations.id }).from(schema.workerOperations);
		expect(operations.map((row) => row.id)).toEqual([session.operationId]);
		expect(calls.registered).toEqual([session.sessionId]);
		expect(calls.prepared).toEqual([session.sessionId]);
		expect(calls.setOperations).toEqual([session.operationId]);
		expect(calls.published).toHaveLength(1);
		expect(calls.published[0]).toMatchObject({ sessionId: session.sessionId, mediaFileId, mode: session.mode });
	});

	test("rolls back reservation and operation when enqueueing fails", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const { service, calls } = createService({ enqueueFails: true });

		// A plain Error is wrapped by safeExecute into an InternalError.
		await expect(service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-2")).rejects.toMatchObject({ category: "internal" });

		const operations = await db.client().select({ id: schema.workerOperations.id }).from(schema.workerOperations);
		expect(operations).toEqual([]);
		expect(calls.releasedReservations).toHaveLength(1);
		expect(calls.discarded).toEqual(calls.releasedReservations);
	});

	test("rejects with a stable 429 code when the concurrent session limit is reached", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const { service, calls } = createService({ reserveFails: true });

		await expect(service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-3")).rejects.toMatchObject({
			code: "stream.limit_reached",
			category: "too_many_requests",
			params: { scope: "server", limit: 2 },
		});

		expect(calls.registered).toEqual([]);
	});

	test("refuses another software transcode once the capacity cap is reached", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const { service, calls } = createService({ softwareTranscodeLimitReached: true });

		await expect(service.createPlaybackSession({ mediaFileId, videoCodecs: ["vp9"] }, "profile-1", "idem-transcode")).rejects.toMatchObject(
			{
				category: "too_many_requests",
				code: "stream.transcode_limit_reached",
			},
		);
		expect(calls.registered).toEqual([]);
	});

	test("rejects a disabled media file", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile({ enabled: false });
		const { service } = createService();

		await expect(service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-4")).rejects.toMatchObject({
			category: "forbidden",
			code: "media_file.disabled",
		});
	});

	test("rejects right after an admin termination", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const { service } = createService({ terminatedByAdmin: true });

		await expect(service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-5")).rejects.toMatchObject({
			category: "forbidden",
			code: "stream.session_terminated",
		});
	});

	test("requires an active profile", async () => {
		const { service } = createService();

		await expect(service.createPlaybackSession(body, undefined, "idem-6")).rejects.toMatchObject({
			code: "auth.profile_required",
			category: "unauthorized",
		});
	});
});

describe("session lifecycle selection and reclaim", () => {
	test("applies the title's saved subtitle language when another version of the title is in progress", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const otherVersion = await seedOtherVersion("meta-1", "/media/f-other.mkv");
		await db.client().insert(schema.profileStreamPrefs).values({ profileId: "profile-1", metadataId: "meta-1", subtitleLanguage: "eng" });
		await db
			.client()
			.insert(schema.playbackProgress)
			.values({ profileId: "profile-1", mediaFileId: otherVersion, position: 600, duration: 1200, completed: false });
		const { service } = createService();

		const session = await service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-7", "user-1");

		expect(session.subtitleId).toBe("sub-eng");
	});

	test("ignores the title's saved subtitle language when the viewer has no progress on it", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		await db.client().insert(schema.profileStreamPrefs).values({ profileId: "profile-1", metadataId: "meta-1", subtitleLanguage: "eng" });
		const { service } = createService();

		const session = await service.createPlaybackSession({ mediaFileId }, "profile-1", "idem-8", "user-1");

		expect(session.subtitleId).toBeNull();
	});

	test("requireSession refuses a path-like session id", () => {
		const { service } = createService();

		expect(() => service.requireSession("../../etc")).toThrow(
			expect.objectContaining({ category: "validation", code: "stream.id_invalid" }),
		);
	});

	test("at the session limit, a profile starting another version of a title takes over its older session slot", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const olderVersion = await seedOtherVersion("meta-1", "/media/f-older.mkv");
		const { service, calls } = createService({
			reserveResults: [false, true],
			profileSessions: [{ sessionId: "older", mediaFileId: olderVersion }],
		});

		const session = await service.createPlaybackSession({ mediaFileId }, "profile-1", "key-reclaim", "user-1");

		expect(calls.releasedSessions).toEqual(["older"]);
		expect(calls.registered).toHaveLength(1);
		expect(session.heartbeatIntervalMs).toBe(10_000);
	});

	test("at the session limit, a profile streaming only other titles is still refused", async () => {
		await seedViewer();
		const mediaFileId = await seedMovieFile();
		const otherTitle = await insertMovieMediaFile(db.client(), "/media/x.mkv", "meta-9");
		const { service, calls } = createService({
			reserveFails: true,
			profileSessions: [{ sessionId: "other", mediaFileId: otherTitle }],
		});

		await expect(service.createPlaybackSession({ mediaFileId }, "profile-1", "key-refused", "user-1")).rejects.toMatchObject({
			code: "stream.limit_reached",
		});
		expect(calls.releasedSessions).toEqual([]);
	});
});

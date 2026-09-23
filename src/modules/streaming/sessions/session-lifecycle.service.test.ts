import { describe, expect, test } from "bun:test";
import type { CreatePlaybackSession } from "@sdk/common/playback-sessions";
import { type ServiceDependencies, SessionLifecycleService } from "./session-lifecycle.service";

function createService(
	options: {
		enqueueFails?: boolean;
		reserveFails?: boolean;
		fileDisabled?: boolean;
		terminatedByAdmin?: boolean;
		subtitles?: Array<{ id: string; language: string; isDefault?: boolean; isForced?: boolean }>;
		streamPrefs?: { audioLanguage: string | null; subtitleLanguage: string | null } | null;
		titleActive?: boolean;
	} = {},
) {
	const calls = {
		registered: [] as string[],
		prepared: [] as string[],
		setOperations: [] as string[],
		removedOperations: [] as string[],
		releasedReservations: [] as string[],
		discarded: [] as string[],
		published: [] as unknown[],
		streamPrefsLookups: [] as Array<{ profileId: string; metadataId: string }>,
	};

	const file = {
		id: "file-1",
		filePath: "/media/f.mkv",
		isEnabled: !options.fileDisabled,
		duration: 1200,
		bitRate: 5_000_000,
		formatName: "matroska",
		videoStreams: [{ index: 0, isDefault: true, codecName: "h264", profile: "high", pixelFormat: "yuv420p", frameRate: "24/1" }],
		audioStreams: [{ index: 1, isDefault: true, language: "pol", codecName: "aac", channels: 2 }],
		subtitles: (options.subtitles ?? []).map((subtitle) => ({
			...subtitle,
			isDefault: subtitle.isDefault ?? false,
			isForced: subtitle.isForced ?? false,
			isHearingImpaired: false,
			streamIndex: null,
			type: "external" as const,
		})),
	};

	const dependencies: ServiceDependencies = {
		mediaRepository: { findForPlaybackSession: async () => file },
		profilePreferencesRepository: {
			getEffective: async () => ({ audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: true, forcedSubtitlesOnly: false }),
		},
		profileStreamPrefsRepository: {
			find: (profileId: string, metadataId: string) => {
				calls.streamPrefsLookups.push({ profileId, metadataId });

				return Promise.resolve(options.streamPrefs ?? null);
			},
		},
		playbackRepository: {
			findProgressUpdateData: async () => ({
				mediaFile: { id: "file-1", duration: 1200, metadataId: "meta-1" },
				existingProgress: undefined,
			}),
			hasActiveTitleProgress: () => Promise.resolve(options.titleActive ?? false),
		},
		systemSettings: { get: () => false },
		workerService: {
			createOperation: async () => ({ id: "op-1" }),
			removeOperation: (id: string) => {
				calls.removedOperations.push(id);
			},
		},
		enqueueStreamInit: options.enqueueFails
			? () => {
					throw new Error("enqueue failed");
				}
			: async () => ({ operationId: "op-1" }),
		runtime: {
			isProfileTerminatedRecently: () => (options.terminatedByAdmin ? { reason: "admin.terminated" } : null),
			reserveSession: () => !options.reserveFails,
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
			releaseSession: () => Promise.resolve("released" as const),
			getTerminatedSession: () => undefined,
		},
		publisher: { publishStarted: (event) => calls.published.push(event) },
		assertEnvironment: () => "/usr/bin/ffmpeg",
	};

	return { service: new SessionLifecycleService(dependencies), calls };
}

const body: CreatePlaybackSession = { mediaFileId: "file-1" };

describe("session lifecycle service", () => {
	test("creates a session: reserves, prepares, enqueues and publishes", async () => {
		const { service, calls } = createService();

		const session = await service.createPlaybackSession(body, "profile-1", "idem-1", "user-1");

		expect(session.sessionId).toBeDefined();
		expect(session.operationId).toBe("op-1");
		expect(calls.registered).toEqual([session.sessionId]);
		expect(calls.prepared).toEqual([session.sessionId]);
		expect(calls.setOperations).toEqual(["op-1"]);
		expect(calls.published).toHaveLength(1);
		expect(calls.published[0]).toMatchObject({ sessionId: session.sessionId, mediaFileId: "file-1", mode: session.mode });
	});

	test("rolls back reservation and operation when enqueueing fails", () => {
		const { service, calls } = createService({ enqueueFails: true });

		// A plain Error is wrapped by safeExecute into an InternalError.
		expect(service.createPlaybackSession(body, "profile-1", "idem-2")).rejects.toThrow("createPlaybackSession failed");

		expect(calls.removedOperations).toEqual(["op-1"]);
		expect(calls.releasedReservations).toHaveLength(1);
		expect(calls.discarded).toEqual(calls.releasedReservations);
	});

	test("conflicts when the concurrent session limit is reached", () => {
		const { service, calls } = createService({ reserveFails: true });

		expect(service.createPlaybackSession(body, "profile-1", "idem-3")).rejects.toThrow("Concurrent streaming session limit");

		expect(calls.registered).toEqual([]);
	});

	test("rejects a disabled media file", () => {
		const { service } = createService({ fileDisabled: true });

		expect(service.createPlaybackSession(body, "profile-1", "idem-4")).rejects.toThrow("disabled");
	});

	test("rejects right after an admin termination", () => {
		const { service } = createService({ terminatedByAdmin: true });

		expect(service.createPlaybackSession(body, "profile-1", "idem-5")).rejects.toThrow("Playback session was terminated");
	});

	test("requires an active profile", () => {
		const { service } = createService();

		expect(service.createPlaybackSession(body, undefined, "idem-6")).rejects.toThrow("An active profile is required");
	});

	test("resolves per-title stream prefs and merges them into the session selection", async () => {
		const { service, calls } = createService({
			subtitles: [
				{ id: "sub-pl", language: "pol", isForced: false },
				{ id: "sub-eng", language: "eng", isForced: false },
			],
			streamPrefs: { audioLanguage: null, subtitleLanguage: "eng" },
			titleActive: true,
		});

		const session = await service.createPlaybackSession(body, "profile-1", "idem-7", "user-1");

		expect(calls.streamPrefsLookups).toEqual([{ profileId: "profile-1", metadataId: "meta-1" }]);
		expect(session.subtitleId).toBe("sub-eng");
	});

	test("skips per-title stream prefs when the title has no active progress", async () => {
		const { service, calls } = createService({
			subtitles: [{ id: "sub-eng", language: "eng", isForced: false }],
			streamPrefs: { audioLanguage: null, subtitleLanguage: "eng" },
		});

		const session = await service.createPlaybackSession(body, "profile-1", "idem-8", "user-1");

		expect(calls.streamPrefsLookups).toEqual([]);
		expect(session.subtitleId).toBeNull();
	});

	test("requireSession validates the id shape before resolving access", () => {
		const { service } = createService();

		expect(() => service.requireSession("../../etc")).toThrow("Invalid sessionId");
	});
});

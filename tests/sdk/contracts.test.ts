import { describe, expect, it } from "bun:test";
import {
	ActiveSessionsResponseSchema,
	AuthProfileSchema,
	AuthSessionSchema,
	AuthUserSchema,
	CreatePlaybackSessionSchema,
	HealthResponseSchema,
	MetadataPlaybackProgressSchema,
	MetadataProviderSearchRequestSchema,
	MetadataProviderSearchResponseSchema,
	MetadataProviderStatusSchema,
	OperationQueuedResponseSchema,
	PluginRuntimeStatusSchema,
	ProjectedResponseSchema,
	SetupAdminRequestSchema,
	SmartPlayResponseSchema,
	StreamSeekResponseSchema,
	SubtitleProviderDownloadRequestSchema,
	SubtitleProviderSearchRequestSchema,
	SubtitleProviderSearchResponseSchema,
	SubtitleSchema,
	TranscodeProgressResponseSchema,
	WorkerJobSchema,
} from "@sdk/common";
import { MetadataWithRelationSchema } from "@sdk/common/metadata.types";
import { defineConfig, field } from "@sdk/plugin";
import { Value } from "@sinclair/typebox/value";

describe("public SDK contracts", () => {
	it("derives a config parser from field specs", () => {
		const config = defineConfig({
			apiKey: field.secret({ label: "API key", required: true, default: "" }),
			language: field.string({ label: "Language", default: "en-US" }),
			maxResults: field.number({ label: "Max results", default: 20, min: 1, max: 50 }),
		});
		expect(config.parse({ apiKey: "secret", language: "pl" })).toEqual({ apiKey: "secret", language: "pl", maxResults: 20 });
		expect(config.parse({})).toEqual({ apiKey: "", language: "en-US", maxResults: 20 });
		expect(() => config.parse({ maxResults: 999 })).toThrow();
	});

	it("defines provider API requests and responses without Drizzle schemas", () => {
		expect(Value.Check(MetadataProviderSearchRequestSchema, { type: "tv_show", title: "Example", year: 2024 })).toBeTrue();
		expect(Value.Check(MetadataProviderSearchRequestSchema, { type: "documentary", title: "Example" })).toBeFalse();
		expect(
			Value.Check(MetadataProviderSearchResponseSchema, {
				providerId: "example",
				results: [{ externalId: "show-1", title: "Example", releaseDate: "2024-01-01" }],
			}),
		).toBeTrue();
		expect(
			Value.Check(MetadataProviderStatusSchema, { id: "example", name: "Example", version: "1.0.0", pluginId: "org.example" }),
		).toBeTrue();
	});

	it("defines setup, health and session API models without database rows", () => {
		const timestamp = "2026-01-01T00:00:00.000Z";
		expect(Value.Check(SetupAdminRequestSchema, { name: "Admin", email: "admin@example.com", password: "password-123" })).toBeTrue();
		expect(Value.Check(SetupAdminRequestSchema, { name: "", email: "invalid", password: "short" })).toBeFalse();
		expect(Value.Check(HealthResponseSchema, { status: "ok", timestamp, uptime: 1, environment: "test", subsystems: [] })).toBeTrue();
		expect(
			Value.Check(AuthUserSchema, {
				id: "user",
				name: "Admin",
				email: "admin@example.com",
				emailVerified: true,
				image: null,
				role: "admin",
				twoFactorEnabled: false,
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
		).toBeTrue();
		expect(
			Value.Check(AuthSessionSchema, {
				id: "session",
				userId: "user",
				expiresAt: timestamp,
				createdAt: timestamp,
				updatedAt: timestamp,
				token: "must-not-be-public",
			}),
		).toBeFalse();
		expect(
			Value.Check(AuthProfileSchema, {
				id: "profile",
				userId: "user",
				name: "Admin",
				avatarUrl: null,
				createdAt: timestamp,
				updatedAt: timestamp,
				pin: "must-not-be-public",
			}),
		).toBeFalse();
	});

	it("keeps subtitle file paths outside public API responses", () => {
		const timestamp = "2026-01-01T00:00:00.000Z";
		expect(
			Value.Check(SubtitleSchema, {
				id: "subtitle",
				mediaFileId: "media",
				language: "pl",
				label: null,
				format: "vtt",
				type: "external",
				streamIndex: null,
				isDefault: false,
				isForced: false,
				isHearingImpaired: false,
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
		).toBeTrue();
		expect(SubtitleSchema.properties).not.toHaveProperty("filePath");
		expect(
			Value.Check(SubtitleSchema, {
				id: "subtitle",
				mediaFileId: "media",
				language: "pl",
				label: null,
				format: "vtt",
				type: "external",
				streamIndex: null,
				isDefault: false,
				isForced: false,
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
		).toBeFalse();
	});

	it("defines subtitle provider search and download requests", () => {
		expect(Value.Check(SubtitleProviderSearchRequestSchema, { mediaFileId: "media-1", languages: ["pl", "en"] })).toBeTrue();
		expect(Value.Check(SubtitleProviderSearchRequestSchema, { mediaFileId: "media-1", languages: ["p"] })).toBeFalse();
		expect(
			Value.Check(SubtitleProviderSearchResponseSchema, {
				providerId: "opensubtitles",
				results: [{ id: "candidate-1", language: "pl", format: "vtt", isForced: false }],
			}),
		).toBeTrue();
		expect(Value.Check(SubtitleProviderDownloadRequestSchema, { mediaFileId: "media-1", subtitleId: "candidate-1" })).toBeTrue();
	});

	it("defines a redacted plugin runtime status for administrative clients", () => {
		expect(
			Value.Check(PluginRuntimeStatusSchema, {
				id: "org.example.catalog",
				name: "Catalog",
				version: "1.0.0",
				state: "failed",
				providers: 0,
				subtitleProviders: 0,
				jobs: 0,
				error: "Missing API key",
				failurePhase: "config",
			}),
		).toBeTrue();
		expect(
			Value.Check(PluginRuntimeStatusSchema, {
				id: "org.example.catalog",
				name: "Catalog",
				version: "1.0.0",
				state: "failed",
				providers: 0,
				subtitleProviders: 0,
				jobs: 0,
				failurePhase: "database",
			}),
		).toBeFalse();
	});

	it("defines operation queue responses and grouped worker item results", () => {
		const timestamp = "2026-01-01T00:00:00.000Z";
		expect(
			Value.Check(OperationQueuedResponseSchema, {
				success: true,
				operationId: "operation-1",
				status: "pending",
			}),
		).toBeTrue();
		expect(
			Value.Check(WorkerJobSchema, {
				id: "task-1",
				workerId: "library-scan",
				dependsOnTaskIds: [],
				status: "completed",
				priority: 0,
				attempts: 1,
				maxAttempts: 3,
				result: { scannedFiles: 12 },
				runAt: timestamp,
				startedAt: timestamp,
				completedAt: timestamp,
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
		).toBeTrue();
	});

	it("accepts nested field projections without weakening the source contract", () => {
		const projectedMetadataSchema = ProjectedResponseSchema(MetadataWithRelationSchema);

		expect(Value.Check(projectedMetadataSchema, { id: "metadata-1", genres: [{ id: "genre-1" }] })).toBeTrue();
		expect(Value.Check(MetadataWithRelationSchema, { id: "metadata-1", genres: [{ id: "genre-1" }] })).toBeFalse();
		expect(Value.Check(projectedMetadataSchema, { genres: [{ id: 123 }] })).toBeFalse();
	});

	it("models serialized playback timestamps as ISO strings", () => {
		const progress = {
			status: "in_progress",
			progress: {
				mediaFileId: "file-1",
				position: 60,
				duration: 120,
				completed: false,
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			fileProgress: {},
			completedEpisodes: 0,
			totalEpisodes: 0,
			episodes: {},
		};
		expect(Value.Check(MetadataPlaybackProgressSchema, progress)).toBeTrue();
		expect(
			Value.Check(MetadataPlaybackProgressSchema, {
				...progress,
				fileProgress: { "file-1": { status: "in_progress", progress: progress.progress } },
			}),
		).toBeTrue();
		expect(Value.Check(MetadataPlaybackProgressSchema, { ...progress, fileProgress: undefined })).toBeFalse();
		expect(
			Value.Check(MetadataPlaybackProgressSchema, {
				...progress,
				progress: { ...progress.progress, updatedAt: new Date("2026-01-01T00:00:00.000Z") },
			}),
		).toBeFalse();
	});

	it("allows smart play responses without a playable suggestion", () => {
		expect(Value.Check(SmartPlayResponseSchema, { suggestion: null })).toBeTrue();
	});

	it("accepts only semantic playback session creation fields", () => {
		expect(Value.Check(CreatePlaybackSessionSchema, { mediaFileId: "file-1", videoCodecs: ["h264"] })).toBeTrue();
		expect(Value.Check(CreatePlaybackSessionSchema, { mediaFileId: "file-1", clientTimestamp: "2026-08-06T00:00:00.000Z" })).toBeFalse();
	});

	it("defines detailed transcode progress and seek responses", () => {
		expect(
			Value.Check(TranscodeProgressResponseSchema, {
				sessionId: "session-1",
				mediaFileId: "file-1",
				state: "transcoding",
				active: true,
				segmentDuration: 6,
				segments: 2,
				transcodedSeconds: 12,
				transcodedUntil: 12,
				duration: 120,
				remainingSeconds: 108,
				progressPercent: 10,
				ranges: [{ startTime: 0, endTime: 12, startSegment: 0, endSegment: 1, segmentCount: 2 }],
			}),
		).toBeTrue();
		expect(Value.Check(StreamSeekResponseSchema, { position: 10, startTime: 6, reusedBuffer: true })).toBeTrue();
	});

	it("defines active session responses without exposing Better Auth tokens", () => {
		const timestamp = "2026-01-01T00:00:00.000Z";
		expect(
			Value.Check(ActiveSessionsResponseSchema, {
				page: 1,
				limit: 20,
				total: 1,
				totalPages: 1,
				data: [
					{
						id: "session-1",
						ipAddress: null,
						userAgent: "Browser",
						createdAt: timestamp,
						updatedAt: timestamp,
						expiresAt: timestamp,
						isCurrent: true,
					},
				],
			}),
		).toBeTrue();
	});
});

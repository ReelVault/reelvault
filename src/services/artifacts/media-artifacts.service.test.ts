import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { mediaArtifactsService } from "./media-artifacts.service";

// Artifacts are written to the migrated test database and to the test artifacts root.
// The only stub is the event bus, so the published events can be read back in order.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

beforeEach(() => {
	// The service is a module singleton: byte totals cached by an earlier test would
	// otherwise leak into this one.
	mediaArtifactsService.invalidateByteTotals();
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Negative-path payloads are intentionally malformed; JSON.parse hands them to write() without fighting the PlaybackArtifactWrite type. */
function malformed(json: string): Parameters<typeof mediaArtifactsService.write>[1] {
	return JSON.parse(json);
}

function seedMediaFile(): Promise<string> {
	return insertMovieMediaFile(db.client(), "/movies/movie.mkv");
}

async function storedArtifacts() {
	return await db.client().select().from(schema.mediaArtifacts);
}

async function onlyArtifact() {
	const [row] = await storedArtifacts();
	if (!row) throw new Error("Expected one stored artifact");

	return row;
}

function storedPath(storageKey: string): string {
	return join(serverConfig.paths.artifacts, storageKey);
}

describe("mediaArtifactsService.write validation", () => {
	test("rejects a non-object artifact payload", async () => {
		await expect(mediaArtifactsService.write("core", malformed('"nope"'))).rejects.toMatchObject({
			code: "artifact.invalid_request",
		});
	});

	test("rejects a missing mediaFileId", async () => {
		await expect(
			mediaArtifactsService.write("core", {
				mediaFileId: "",
				kind: "chapters",
				contentType: "text/vtt",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "artifact.invalid_request" });
	});

	test("rejects an unsupported kind", async () => {
		await expect(
			mediaArtifactsService.write("core", malformed('{"mediaFileId":"mf-1","kind":"evil","contentType":"text/vtt","content":"V0VCVlRU"}')),
		).rejects.toMatchObject({ code: "artifact.invalid_request" });
	});

	test("rejects a disallowed content type", async () => {
		await expect(
			mediaArtifactsService.write("core", {
				mediaFileId: "mf-1",
				kind: "chapters",
				contentType: "text/html",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "artifact.invalid_content_type" });
	});

	test("rejects content above the per-artifact size limit", async () => {
		const oversized = new Uint8Array(serverConfig.plugins.artifacts.maxSizeBytes + 1);

		await expect(
			mediaArtifactsService.write("core", {
				mediaFileId: "mf-1",
				kind: "chapters",
				contentType: "text/vtt",
				content: oversized,
			}),
		).rejects.toMatchObject({ code: "artifact.too_large" });
	});

	test("rejects a write for a media file that does not exist and stores nothing", async () => {
		await expect(
			mediaArtifactsService.write("core", {
				mediaFileId: "mf-missing",
				kind: "chapters",
				contentType: "text/vtt",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "artifact.not_found" });
		expect(await storedArtifacts()).toEqual([]);
	});
});

describe("mediaArtifactsService.write quota gate", () => {
	test("a gate rejection stops the write before a second row is stored", async () => {
		const mediaFileId = await seedMediaFile();
		await mediaArtifactsService.write("core", {
			mediaFileId,
			kind: "chapters",
			contentType: "text/vtt",
			content: bytes("x".repeat(100)),
		});
		const gateError = new Error("gate rejected");
		const gateCalls: Array<[string, number, number]> = [];

		await expect(
			mediaArtifactsService.write(
				"core",
				{ mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("12345") },
				{
					assertWithinQuota: (ownerId, bytesAfterWrite, incomingBytes) => {
						gateCalls.push([ownerId, bytesAfterWrite, incomingBytes]);
						throw gateError;
					},
				},
			),
		).rejects.toBe(gateError);

		expect(gateCalls).toEqual([["core", 105, 5]]);
		expect(await storedArtifacts()).toHaveLength(1);
	});
});

describe("mediaArtifactsService.write happy path", () => {
	test("stores the file and row, returns the public artifact and publishes artifact.created", async () => {
		const mediaFileId = await seedMediaFile();
		const published: Array<{ event: string; payload: unknown }> = [];
		stubs.push(
			stubMethod(pluginEventBus, "publish", (event: string, payload: unknown) => {
				published.push({ event, payload });
			}),
		);

		const result = await mediaArtifactsService.write("org.reelvault.test", {
			mediaFileId,
			kind: "trickplay",
			contentType: "text/vtt",
			content: bytes("WEBVTT\n"),
		});

		const row = await onlyArtifact();
		expect(row).toMatchObject({ id: result.id, mediaFileId, pluginId: "org.reelvault.test", kind: "trickplay" });
		expect(await file(storedPath(row.storageKey)).text()).toBe("WEBVTT\n");
		expect(result).toEqual({
			id: row.id,
			mediaFileId,
			pluginId: "org.reelvault.test",
			kind: "trickplay",
			url: `/v1/media-files/${mediaFileId}/artifacts/${row.id}`,
			contentType: "text/vtt",
			createdAt: row.createdAt.toISOString(),
		});
		expect(published).toEqual([{ event: "artifact.created", payload: { mediaFileId, artifactId: result.id, artifactType: "trickplay" } }]);
	});
});

describe("mediaArtifactsService byte totals", () => {
	test("a delete makes the next quota check count only the bytes that are still stored", async () => {
		const mediaFileId = await seedMediaFile();
		const ownerId = "org.reelvault.quota-cache";
		const seenTotals: number[] = [];
		const write = () =>
			mediaArtifactsService.write(
				ownerId,
				{ mediaFileId, kind: "trickplay", contentType: "image/webp", content: bytes("0123456789") },
				{
					assertWithinQuota: (_owner, bytesAfterWrite) => {
						seenTotals.push(bytesAfterWrite);
					},
				},
			);

		await write();
		await write();
		expect(seenTotals).toEqual([10, 20]);

		await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", ownerId);
		await write();

		// Two 10-byte artifacts were removed, so only the new one counts. A stale cached total would report 30.
		expect(seenTotals).toEqual([10, 20, 10]);
	});
});

describe("mediaArtifactsService.getMediaFileStoredBytes", () => {
	test("sums only the requested owner's stored bytes for that media file", async () => {
		const mediaFileId = await seedMediaFile();
		await mediaArtifactsService.write("core", { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("x".repeat(100)) });
		await mediaArtifactsService.write("core", { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("x".repeat(100)) });
		await mediaArtifactsService.write("org.reelvault.test", {
			mediaFileId,
			kind: "chapters",
			contentType: "text/vtt",
			content: bytes("x".repeat(50)),
		});

		expect(await mediaArtifactsService.getMediaFileStoredBytes(mediaFileId, "core")).toBe(200);
	});
});

describe("mediaArtifactsService.list", () => {
	test("maps stored rows to public artifact urls", async () => {
		const mediaFileId = await seedMediaFile();
		const written = await mediaArtifactsService.write("org.reelvault.test", {
			mediaFileId,
			kind: "chapters",
			contentType: "application/json",
			content: bytes("{}"),
		});

		const row = await onlyArtifact();
		expect(await mediaArtifactsService.list(mediaFileId)).toEqual([
			{
				id: written.id,
				mediaFileId,
				pluginId: "org.reelvault.test",
				kind: "chapters",
				contentType: "application/json",
				url: `/v1/media-files/${mediaFileId}/artifacts/${written.id}`,
				createdAt: row.createdAt.toISOString(),
			},
		]);
	});
});

describe("mediaArtifactsService.removeStorageFiles", () => {
	test("deletes the file behind each storage key and leaves the rows alone", async () => {
		const mediaFileId = await seedMediaFile();
		await mediaArtifactsService.write("core", { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("a") });
		await mediaArtifactsService.write("core", { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("b") });
		const rows = await storedArtifacts();

		await mediaArtifactsService.removeStorageFiles(rows.map((row) => row.storageKey));

		for (const row of rows) expect(await file(storedPath(row.storageKey)).exists()).toBe(false);
		expect(await storedArtifacts()).toHaveLength(2);
	});
});

describe("mediaArtifactsService bulk cleanup", () => {
	test("deleteByMediaFileIdAndKind removes only the owner's artifacts of that kind, rows and files", async () => {
		const mediaFileId = await seedMediaFile();
		const owner = "org.reelvault.test";
		await mediaArtifactsService.write(owner, { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("a") });
		await mediaArtifactsService.write(owner, { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("b") });
		await mediaArtifactsService.write(owner, { mediaFileId, kind: "trickplay", contentType: "image/webp", content: bytes("c") });
		await mediaArtifactsService.write("core", { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("d") });
		const chaptersOfOwner = (await storedArtifacts()).filter((row) => row.pluginId === owner && row.kind === "chapters");

		expect(await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "chapters", owner)).toBe(2);

		const remaining = await storedArtifacts();
		expect(remaining.map((row) => `${row.pluginId}:${row.kind}`).toSorted()).toEqual(["core:chapters", "org.reelvault.test:trickplay"]);
		for (const row of chaptersOfOwner) expect(await file(storedPath(row.storageKey)).exists()).toBe(false);
	});

	test("removeForOwner removes every artifact of that owner, rows and files, and keeps other owners' artifacts", async () => {
		const mediaFileId = await seedMediaFile();
		await mediaArtifactsService.write("core", { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes("a") });
		await mediaArtifactsService.write("core", { mediaFileId, kind: "trickplay", contentType: "image/webp", content: bytes("b") });
		await mediaArtifactsService.write("org.reelvault.test", {
			mediaFileId,
			kind: "chapters",
			contentType: "text/vtt",
			content: bytes("c"),
		});
		const coreRows = (await storedArtifacts()).filter((row) => row.pluginId === "core");

		expect(await mediaArtifactsService.removeForOwner("core")).toBe(2);

		const remaining = await storedArtifacts();
		expect(remaining.map((row) => row.pluginId)).toEqual(["org.reelvault.test"]);
		for (const row of coreRows) expect(await file(storedPath(row.storageKey)).exists()).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { eq } from "drizzle-orm";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { PathUtils } from "@/utils/path.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginBlobsService } from "./plugin.blobs";

// Blobs are written to the migrated test database and to the test blob root, so the
// tests read back rows and files. Nothing is stubbed.
const db = useTestDatabase();

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLUGIN = "org.reelvault.test";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function storedBlobs() {
	return await db.client().select().from(schema.pluginBlobs);
}

function blobPath(storageKey: string): string {
	return PathUtils.join(serverConfig.paths.pluginBlobs, storageKey);
}

/** Pushes a stored blob into the past so the next read treats it as expired. */
async function expireBlob(key: string): Promise<void> {
	await db
		.client()
		.update(schema.pluginBlobs)
		.set({ expiresAt: new Date(Date.now() - 1_000) })
		.where(eq(schema.pluginBlobs.key, key));
}

describe("pluginBlobsService.put", () => {
	test("stores the bytes and the row, and returns metadata with ISO timestamps", async () => {
		const metadata = await pluginBlobsService.put(PLUGIN, "settings.json", bytes('{"a":1}'), {
			contentType: "application/json",
			expiresInMs: 60_000,
		});

		expect(metadata).toMatchObject({ key: "settings.json", contentType: "application/json", size: 7 });
		expect(metadata.createdAt).toMatch(ISO_TIMESTAMP);
		expect(metadata.expiresAt).toMatch(ISO_TIMESTAMP);
		const [row] = await storedBlobs();
		expect(row).toMatchObject({ pluginId: PLUGIN, key: "settings.json", contentType: "application/json", size: 7 });
		expect(await file(blobPath(row?.storageKey ?? "")).text()).toBe('{"a":1}');
	});

	test("rejects a write that would exceed the plugin quota and stores nothing", async () => {
		// The quota is summed from the rows, so a row already at the limit is enough.
		await db
			.client()
			.insert(schema.pluginBlobs)
			.values({
				pluginId: PLUGIN,
				key: "existing.bin",
				storageKey: "existing-blob",
				contentType: "application/octet-stream",
				size: serverConfig.plugins.blobs.maxStorageBytes,
				expiresAt: new Date(Date.now() + 60_000),
			});

		await expect(
			pluginBlobsService.put(PLUGIN, "settings.json", bytes("x"), { contentType: "text/plain", expiresInMs: 60_000 }),
		).rejects.toMatchObject({ category: "validation", code: "plugin.blobs_quota_exceeded" });
		expect((await storedBlobs()).map((row) => row.key)).toEqual(["existing.bin"]);
	});

	test("replaces an entry under the same key and removes the file it replaced", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("first"), { contentType: "text/plain", expiresInMs: 60_000 });
		const [before] = await storedBlobs();

		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("fresh"), { contentType: "text/plain", expiresInMs: 60_000 });

		const rows = await storedBlobs();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: "settings.json", size: 5 });
		expect(await file(blobPath(before?.storageKey ?? "")).exists()).toBe(false);
		expect(await file(blobPath(rows[0]?.storageKey ?? "")).text()).toBe("fresh");
	});

	test("replaces an expired entry under the same key and removes the expired file", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("old"), { contentType: "text/plain", expiresInMs: 60_000 });
		const [expired] = await storedBlobs();
		await expireBlob("settings.json");

		const metadata = await pluginBlobsService.put(PLUGIN, "settings.json", bytes("fresh"), {
			contentType: "text/plain",
			expiresInMs: 60_000,
		});

		expect(metadata.size).toBe(5);
		const rows = await storedBlobs();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.storageKey).not.toBe(expired?.storageKey);
		expect(await file(blobPath(expired?.storageKey ?? "")).exists()).toBe(false);
	});
});

describe("pluginBlobsService.get", () => {
	test("returns the stored content and metadata for a live entry", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("live"), { contentType: "text/plain", expiresInMs: 60_000 });

		const blob = await pluginBlobsService.get(PLUGIN, "settings.json");

		expect(blob).toMatchObject({ key: "settings.json", contentType: "text/plain", size: 4 });
		expect(await blob?.content.text()).toBe("live");
	});

	test("returns undefined and deletes an expired entry with its file", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("stale"), { contentType: "text/plain", expiresInMs: 60_000 });
		const [row] = await storedBlobs();
		await expireBlob("settings.json");

		await expect(pluginBlobsService.get(PLUGIN, "settings.json")).resolves.toBeUndefined();

		expect(await storedBlobs()).toEqual([]);
		expect(await file(blobPath(row?.storageKey ?? "")).exists()).toBe(false);
	});

	test("returns undefined and drops the row when its file is missing on disk", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("gone"), { contentType: "text/plain", expiresInMs: 60_000 });
		const [row] = await storedBlobs();
		await file(blobPath(row?.storageKey ?? "")).delete();

		await expect(pluginBlobsService.get(PLUGIN, "settings.json")).resolves.toBeUndefined();

		expect(await storedBlobs()).toEqual([]);
	});

	test("returns undefined for an unknown key", async () => {
		await expect(pluginBlobsService.get(PLUGIN, "missing.json")).resolves.toBeUndefined();
	});
});

describe("pluginBlobsService.delete", () => {
	test("removes the row and the stored file when the entry exists", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("bye"), { contentType: "text/plain", expiresInMs: 60_000 });
		const [row] = await storedBlobs();

		await pluginBlobsService.delete(PLUGIN, "settings.json");

		expect(await storedBlobs()).toEqual([]);
		expect(await file(blobPath(row?.storageKey ?? "")).exists()).toBe(false);
	});

	test("is a no-op for an unknown key", async () => {
		await pluginBlobsService.put(PLUGIN, "other.json", bytes("kept"), { contentType: "text/plain", expiresInMs: 60_000 });

		await expect(pluginBlobsService.delete(PLUGIN, "missing.json")).resolves.toBeUndefined();

		expect((await storedBlobs()).map((row) => row.key)).toEqual(["other.json"]);
	});
});

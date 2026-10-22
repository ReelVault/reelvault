import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { file } from "bun";
import { eq } from "drizzle-orm";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { isNullish } from "@/utils/type.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginBlobsService } from "./plugin.blobs";

// Blobs are written to the migrated test database and to the test blob root, so the
// tests read back rows and files. Nothing is stubbed.
const db = useTestDatabase();

const PLUGIN = "org.reelvault.test";

afterEach(() => {
	setSystemTime();
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function storedBlobs() {
	return await db.client().select().from(schema.pluginBlobs);
}

/** The single stored row. A test that expects one entry fails here when there is none or several. */
async function onlyStoredBlob() {
	const rows = await storedBlobs();
	const [row] = rows;
	if (rows.length !== 1 || isNullish(row)) throw new Error(`Expected one stored blob, found ${rows.length}`);

	return row;
}

function blobPath(storageKey: string): string {
	return join(serverConfig.paths.pluginBlobs, storageKey);
}

/** Pushes a stored blob into the past so the next read treats it as expired. */
async function expireBlob(key: string): Promise<void> {
	await db
		.client()
		.update(schema.pluginBlobs)
		.set({ expiresAt: new Date(Date.now() - 1_000) })
		.where(eq(schema.pluginBlobs.key, key));
}

/** Fills part of the plugin's quota with a row that has no file, as an earlier write would leave it. */
async function seedQuotaUse(size: number): Promise<void> {
	await db
		.client()
		.insert(schema.pluginBlobs)
		.values({
			pluginId: PLUGIN,
			key: "existing.bin",
			storageKey: "existing-blob",
			contentType: "application/octet-stream",
			size,
			expiresAt: new Date(Date.now() + 60_000),
		});
}

describe("pluginBlobsService.put", () => {
	test("stores the bytes and the row, and dates the metadata at the write and at its expiry", async () => {
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

		const metadata = await pluginBlobsService.put(PLUGIN, "settings.json", bytes('{"a":1}'), {
			contentType: "application/json",
			expiresInMs: 60_000,
		});

		expect(metadata).toEqual({
			key: "settings.json",
			contentType: "application/json",
			size: 7,
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2026-01-01T00:01:00.000Z",
		});
		const row = await onlyStoredBlob();
		expect(row).toMatchObject({ pluginId: PLUGIN, key: "settings.json", contentType: "application/json", size: 7 });
		expect(await file(blobPath(row.storageKey)).text()).toBe('{"a":1}');
	});

	test("rejects a write that would exceed the plugin quota and stores nothing", async () => {
		await seedQuotaUse(serverConfig.plugins.blobs.maxStorageBytes);

		await expect(
			pluginBlobsService.put(PLUGIN, "settings.json", bytes("x"), { contentType: "text/plain", expiresInMs: 60_000 }),
		).rejects.toMatchObject({ category: "validation", code: "plugin.blobs_quota_exceeded" });
		expect((await storedBlobs()).map((row) => row.key)).toEqual(["existing.bin"]);
	});

	test("accepts a write that fills the plugin quota exactly", async () => {
		await seedQuotaUse(serverConfig.plugins.blobs.maxStorageBytes - 1);

		const metadata = await pluginBlobsService.put(PLUGIN, "settings.json", bytes("x"), { contentType: "text/plain", expiresInMs: 60_000 });

		expect(metadata.size).toBe(1);
		expect((await storedBlobs()).map((row) => row.key).toSorted()).toEqual(["existing.bin", "settings.json"]);
	});

	test("replaces an entry under the same key and removes the file it replaced", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("first"), { contentType: "text/plain", expiresInMs: 60_000 });
		const before = await onlyStoredBlob();

		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("fresh"), { contentType: "text/plain", expiresInMs: 60_000 });

		const after = await onlyStoredBlob();
		expect(after).toMatchObject({ key: "settings.json", size: 5 });
		expect(await file(blobPath(before.storageKey)).exists()).toBe(false);
		expect(await file(blobPath(after.storageKey)).text()).toBe("fresh");
	});

	test("replaces an expired entry under the same key and removes the expired file", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("old"), { contentType: "text/plain", expiresInMs: 60_000 });
		const expired = await onlyStoredBlob();
		await expireBlob("settings.json");

		const metadata = await pluginBlobsService.put(PLUGIN, "settings.json", bytes("fresh"), {
			contentType: "text/plain",
			expiresInMs: 60_000,
		});

		expect(metadata.size).toBe(5);
		const after = await onlyStoredBlob();
		expect(after.storageKey).not.toBe(expired.storageKey);
		expect(await file(blobPath(expired.storageKey)).exists()).toBe(false);
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
		const row = await onlyStoredBlob();
		await expireBlob("settings.json");

		await expect(pluginBlobsService.get(PLUGIN, "settings.json")).resolves.toBeUndefined();

		expect(await storedBlobs()).toEqual([]);
		expect(await file(blobPath(row.storageKey)).exists()).toBe(false);
	});

	test("returns undefined and drops the row when its file is missing on disk", async () => {
		await pluginBlobsService.put(PLUGIN, "settings.json", bytes("gone"), { contentType: "text/plain", expiresInMs: 60_000 });
		const row = await onlyStoredBlob();
		await file(blobPath(row.storageKey)).delete();

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
		const row = await onlyStoredBlob();

		await pluginBlobsService.delete(PLUGIN, "settings.json");

		expect(await storedBlobs()).toEqual([]);
		expect(await file(blobPath(row.storageKey)).exists()).toBe(false);
	});

	test("is a no-op for an unknown key", async () => {
		await pluginBlobsService.put(PLUGIN, "other.json", bytes("kept"), { contentType: "text/plain", expiresInMs: 60_000 });

		await expect(pluginBlobsService.delete(PLUGIN, "missing.json")).resolves.toBeUndefined();

		expect((await storedBlobs()).map((row) => row.key)).toEqual(["other.json"]);
	});
});

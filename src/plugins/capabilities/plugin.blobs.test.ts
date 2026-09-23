import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databaseFactory } from "@/database/database";
import { pluginBlobsRepository } from "@/database/repositories/plugin-storage.repository";
import { FileUtils } from "@/utils/file.utils";
import { pluginBlobsService } from "./plugin.blobs";

function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function blobRow(overrides: Record<string, unknown> = {}) {
	return {
		pluginId: "org.reelvault.test",
		key: "settings.json",
		storageKey: "stored-1",
		contentType: "application/json",
		size: 6,
		createdAt: new Date("2020-01-01T00:00:00Z"),
		updatedAt: new Date("2020-01-01T00:00:00Z"),
		expiresAt: new Date(Date.now() + 60_000),
		...overrides,
	};
}

describe("pluginBlobsService.put", () => {
	test("writes the blob file and returns metadata with ISO timestamps", async () => {
		const setValues: Array<Record<string, unknown>> = [];
		activeStubs.push(
			stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(undefined)),
			stubMethod(pluginBlobsRepository, "sumSizeByPlugin", () => Promise.resolve(0)),
			stubMethod(pluginBlobsRepository, "set", (values: Record<string, unknown>) => {
				setValues.push(values);

				return Promise.resolve(undefined);
			}),
			stubMethod(databaseFactory, "transaction", (callback: (tx: unknown) => Promise<unknown>) => callback({})),
		);

		const metadata = await pluginBlobsService.put("org.reelvault.test", "settings.json", bytes('{"a":1}'), {
			contentType: "application/json",
			expiresInMs: 60_000,
		});

		expect(metadata).toMatchObject({
			key: "settings.json",
			contentType: "application/json",
			size: 7,
		});
		expect(metadata.createdAt).not.toBeNull();
		expect(metadata.expiresAt).not.toBeNull();
		expect(setValues).toHaveLength(1);
		expect(setValues[0]).toMatchObject({
			pluginId: "org.reelvault.test",
			key: "settings.json",
			contentType: "application/json",
			size: 7,
		});
	});

	test("rejects the write when the plugin storage quota is exhausted", async () => {
		activeStubs.push(
			stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(undefined)),
			stubMethod(pluginBlobsRepository, "sumSizeByPlugin", () => Promise.resolve(100 * 1024 * 1024)),
			stubMethod(databaseFactory, "transaction", (callback: (tx: unknown) => Promise<unknown>) => callback({})),
		);

		await expect(
			pluginBlobsService.put("org.reelvault.test", "settings.json", bytes("x"), { contentType: "text/plain", expiresInMs: 60_000 }),
		).rejects.toThrow("must not exceed");
	});

	test("replaces an expired entry found under the same key", async () => {
		const expiredRow = blobRow({ expiresAt: new Date(Date.now() - 1_000) });
		const deleted: string[] = [];
		activeStubs.push(
			stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(expiredRow)),
			stubMethod(pluginBlobsRepository, "sumSizeByPlugin", () => Promise.resolve(0)),
			stubMethod(pluginBlobsRepository, "delete", (pluginId: string, key: string) => {
				deleted.push(`${pluginId}:${key}`);

				return Promise.resolve();
			}),
			stubMethod(FileUtils, "delete", () => Promise.resolve(true)),
			stubMethod(pluginBlobsRepository, "set", () => Promise.resolve(undefined)),
			stubMethod(databaseFactory, "transaction", (callback: (tx: unknown) => Promise<unknown>) => callback({})),
		);

		const metadata = await pluginBlobsService.put("org.reelvault.test", "settings.json", bytes("fresh"), {
			contentType: "text/plain",
			expiresInMs: 60_000,
		});

		expect(metadata.size).toBe(5);
		expect(deleted).toEqual(["org.reelvault.test:settings.json"]);
	});
});

describe("pluginBlobsService.get", () => {
	test("returns undefined and deletes an expired entry", async () => {
		const expiredRow = blobRow({ expiresAt: new Date(Date.now() - 1_000) });
		const deletedRows: Array<[string, string]> = [];
		activeStubs.push(
			stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(expiredRow)),
			stubMethod(pluginBlobsRepository, "delete", (pluginId: string, key: string) => {
				deletedRows.push([pluginId, key]);

				return Promise.resolve();
			}),
			stubMethod(FileUtils, "delete", () => Promise.resolve(true)),
		);

		await expect(pluginBlobsService.get("org.reelvault.test", "settings.json")).resolves.toBeUndefined();
		expect(deletedRows).toEqual([["org.reelvault.test", "settings.json"]]);
	});

	test("returns undefined for an unknown key", async () => {
		activeStubs.push(stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(undefined)));

		await expect(pluginBlobsService.get("org.reelvault.test", "settings.json")).resolves.toBeUndefined();
	});
});

describe("pluginBlobsService.delete", () => {
	test("removes the row and the stored file when the entry exists", async () => {
		const deletedRows: Array<[string, string]> = [];
		const deletedFiles: string[] = [];
		activeStubs.push(
			stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(blobRow())),
			stubMethod(pluginBlobsRepository, "delete", (pluginId: string, key: string) => {
				deletedRows.push([pluginId, key]);

				return Promise.resolve();
			}),
			stubMethod(FileUtils, "delete", (path: string) => {
				deletedFiles.push(path);

				return Promise.resolve(true);
			}),
		);

		await pluginBlobsService.delete("org.reelvault.test", "settings.json");

		expect(deletedRows).toEqual([["org.reelvault.test", "settings.json"]]);
		expect(deletedFiles).toHaveLength(1);
		expect(deletedFiles[0]?.endsWith("stored-1")).toBe(true);
	});

	test("is a no-op for an unknown key", async () => {
		activeStubs.push(stubMethod(pluginBlobsRepository, "find", () => Promise.resolve(undefined)));

		await expect(pluginBlobsService.delete("org.reelvault.test", "settings.json")).resolves.toBeUndefined();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { pluginMetadataService } from "./plugin.metadata";

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

describe("pluginMetadataService.get", () => {
	test("maps nullable fields to undefined and providers to externalIds", async () => {
		activeStubs.push(
			stubMethod(metadataRepository, "findById", () =>
				Promise.resolve({
					id: "meta-1",
					type: "movie",
					title: "Movie",
					originalTitle: null,
					overview: "Plot",
					tagline: null,
					releaseDate: "2020-01-01",
					status: null,
					providers: [
						{ name: "tmdb", externalId: "42" },
						{ name: "imdb", externalId: "tt0000042" },
					],
				}),
			),
		);

		const result = await pluginMetadataService.get("meta-1");

		expect(result).toEqual({
			id: "meta-1",
			type: "movie",
			title: "Movie",
			originalTitle: undefined,
			overview: "Plot",
			tagline: undefined,
			releaseDate: "2020-01-01",
			status: undefined,
			externalIds: [
				{ providerId: "tmdb", entityType: "movie", externalId: "42" },
				{ providerId: "imdb", entityType: "movie", externalId: "tt0000042" },
			],
		});
		expect(result?.originalTitle).toBeUndefined();
		expect(result?.status).toBeUndefined();
	});

	test("returns null for unknown metadata", async () => {
		activeStubs.push(stubMethod(metadataRepository, "findById", () => Promise.resolve(undefined)));

		await expect(pluginMetadataService.get("missing")).resolves.toBeNull();
	});
});

describe("pluginMetadataService.findManyByExternalIds", () => {
	test("maps availability rows with file counts", async () => {
		activeStubs.push(
			stubMethod(metadataRepository, "findByProviderExternalIds", () =>
				Promise.resolve([
					{ externalId: "42", metadata: { id: "meta-1", title: "Movie", type: "movie" }, fileCount: 2 },
					{ externalId: "43", metadata: { id: "meta-2", title: "Other", type: "movie" }, fileCount: 0 },
				]),
			),
		);

		const rows = await pluginMetadataService.findManyByExternalIds("tmdb", ["42", "43"], "movie");

		expect(rows).toEqual([
			{ externalId: "42", metadataId: "meta-1", title: "Movie", type: "movie", hasFiles: true, fileCount: 2 },
			{ externalId: "43", metadataId: "meta-2", title: "Other", type: "movie", hasFiles: false, fileCount: 0 },
		]);
	});
});

describe("pluginMetadataService.findByExternalId", () => {
	test("returns the first availability match", async () => {
		activeStubs.push(
			stubMethod(metadataRepository, "findByProviderExternalIds", () =>
				Promise.resolve([{ externalId: "42", metadata: { id: "meta-1", title: "Movie", type: "movie" }, fileCount: 1 }]),
			),
		);

		await expect(pluginMetadataService.findByExternalId("tmdb", "42", "movie")).resolves.toMatchObject({
			metadataId: "meta-1",
			hasFiles: true,
		});
	});

	test("returns null when nothing matches", async () => {
		activeStubs.push(stubMethod(metadataRepository, "findByProviderExternalIds", () => Promise.resolve([])));

		await expect(pluginMetadataService.findByExternalId("tmdb", "nope", "movie")).resolves.toBeNull();
	});
});

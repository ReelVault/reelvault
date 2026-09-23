import { afterEach, describe, expect, test } from "bun:test";
import { sidecarAssetsService } from "./sidecar-assets.service";

function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { restore(): void } {
	const original = Reflect.get(target, method);
	Reflect.set(target, method, (...args: never[]) => impl(...args));

	return {
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("sidecarAssetsService", () => {
	test("walks every library path once and flattens the ignored assets", async () => {
		const libraries = await import("@/application/libraries/libraries.service");
		const sidecars = await import("./metadata-sidecars.service");
		const ignoredByRoot = new Map([
			["/media/a", [{ path: "/media/a/logo.png", fileName: "logo.png", reason: "unsupported-artwork-type" }]],
			["/media/b", [{ path: "/media/b/banner.jpg", fileName: "banner.jpg", reason: "unsupported-artwork-type" }]],
		]);
		const walkCalls: string[] = [];
		activeStubs.push(
			stubMethod(libraries.librariesService, "getById", (libraryId: string) => {
				return Promise.resolve({ id: libraryId, paths: [{ path: "/media/a" }, { path: "/media/b" }] });
			}),
			stubMethod(sidecars.metadataSidecarsService, "findIgnoredAssets", (root: string) => {
				walkCalls.push(root);

				return Promise.resolve(ignoredByRoot.get(root) ?? []);
			}),
		);

		const assets = await sidecarAssetsService.getIgnoredAssets("library-assets-1");

		expect(walkCalls).toEqual(["/media/a", "/media/b"]);
		expect(assets).toEqual([
			{ path: "/media/a/logo.png", fileName: "logo.png", reason: "unsupported-artwork-type" },
			{ path: "/media/b/banner.jpg", fileName: "banner.jpg", reason: "unsupported-artwork-type" },
		]);
	});

	test("serves repeated refreshes from the TTL cache", async () => {
		const libraries = await import("@/application/libraries/libraries.service");
		const sidecars = await import("./metadata-sidecars.service");
		let lookups = 0;
		activeStubs.push(
			stubMethod(libraries.librariesService, "getById", () => {
				lookups++;

				return Promise.resolve({ id: "lib", paths: [{ path: "/media/cached" }] });
			}),
			stubMethod(sidecars.metadataSidecarsService, "findIgnoredAssets", () => Promise.resolve([])),
		);

		await sidecarAssetsService.getIgnoredAssets("library-assets-cache");
		await sidecarAssetsService.getIgnoredAssets("library-assets-cache");

		expect(lookups).toBe(1);
	});
});

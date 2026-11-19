import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { stubFetch } from "../../tests/helpers/fetch-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../tests/helpers/module-mock.helper";

let resolvedAddresses: string[] = [];
let lookupFailure: Error | undefined;

// The guard resolves every hostname before the request, so DNS is the external boundary this file steers.
mockModuleWithRealExports("node:dns/promises", {
	lookup: () => {
		if (lookupFailure) throw lookupFailure;

		return Promise.resolve(resolvedAddresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
	},
});

const { guardedFetch } = await import("./url-guard.utils");

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	resolvedAddresses = [];
	lookupFailure = undefined;
});

afterAll(() => restoreModuleMocks());

describe("guardedFetch resolution", () => {
	test("rejects a host when any resolved address is private", async () => {
		resolvedAddresses = ["8.8.8.8", "127.0.0.1"];
		const calls = stubFetch();

		await expect(guardedFetch("https://mixed.example/file")).rejects.toMatchObject({
			category: "validation",
			code: "download.host_blocked",
		});
		expect(calls).toEqual([]);
	});

	test("pins a dual-stack host to its IPv4 address", async () => {
		resolvedAddresses = ["2606:4700:4700::1111", "8.8.8.8"];
		const calls = stubFetch();

		await guardedFetch("https://dual.example/file");

		expect(calls.map((call) => call.url)).toEqual(["https://8.8.8.8/file"]);
	});

	test("rejects a host whose resolution fails", async () => {
		lookupFailure = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
		const calls = stubFetch();

		await expect(guardedFetch("https://missing.example/file")).rejects.toMatchObject({
			category: "validation",
			code: "download.host_unresolved",
		});
		expect(calls).toEqual([]);
	});

	test("rejects a host that resolves to no address", async () => {
		resolvedAddresses = [];
		const calls = stubFetch();

		await expect(guardedFetch("https://empty.example/file")).rejects.toMatchObject({
			category: "validation",
			code: "download.host_blocked",
		});
		expect(calls).toEqual([]);
	});
});

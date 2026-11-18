import { afterEach, describe, expect, it } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { guardedPluginFetch, isHostAllowed } from "./plugin.http";

describe("isHostAllowed", () => {
	it("allows everything when the allowlist is empty", () => {
		expect(isHostAllowed("api.tmdb.org", "")).toBeTrue();
		expect(isHostAllowed("evil.example.com", "  ")).toBeTrue();
	});

	it("enforces exact hosts and covers their subdomains", () => {
		const list = "api.themoviedb.org, image.tmdb.org";
		expect(isHostAllowed("api.themoviedb.org", list)).toBeTrue();
		expect(isHostAllowed("image.tmdb.org", list)).toBeTrue();
		expect(isHostAllowed("evil.themoviedb.org", list)).toBeFalse();
		expect(isHostAllowed("themoviedb.org", list)).toBeFalse();
	});

	it("covers subdomains of a bare-domain entry", () => {
		expect(isHostAllowed("api.themoviedb.org", "themoviedb.org")).toBeTrue();
		expect(isHostAllowed("notthemoviedb.org", "themoviedb.org")).toBeFalse();
	});

	it("is case-insensitive and trims entries", () => {
		expect(isHostAllowed("API.TMDB.ORG", " api.tmdb.org , other.org ")).toBeTrue();
	});
});

describe("guardedPluginFetch", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("rejects local hosts before any request", async () => {
		await expect(guardedPluginFetch("http://localhost/x")).rejects.toMatchObject({
			category: "forbidden",
			code: "plugin.http.private_address",
		});
	});

	it.each(["printer.local", "api.localhost", "vault.internal", "nas.home.arpa"])(
		"rejects the local hostname %s before any request",
		async (hostname) => {
			await expect(guardedPluginFetch(`http://${hostname}/x`)).rejects.toMatchObject({
				category: "forbidden",
				code: "plugin.http.private_address",
			});
		},
	);

	it("caps every plugin fetch with a 30 second abort timeout", async () => {
		let capturedMs = -1;
		const timeoutStub = stubMethod(AbortSignal, "timeout", (ms: number) => {
			capturedMs = ms;
			return new AbortController().signal;
		});
		const fetchStub = stubMethod(globalThis, "fetch", () => Promise.resolve(new Response("ok")));
		try {
			await guardedPluginFetch("http://1.1.1.1/media");
		} finally {
			timeoutStub.restore();
			fetchStub.restore();
		}
		expect(capturedMs).toBe(30_000);
	});

	it("stops after five redirects and refuses the fetch", async () => {
		let calls = 0;
		const fetchStub = stubMethod(globalThis, "fetch", () => {
			calls++;
			return Promise.resolve(new Response(null, { status: 302, headers: { location: "/next" } }));
		});

		try {
			await expect(guardedPluginFetch("http://1.1.1.1/start")).rejects.toMatchObject({
				code: "download.too_many_redirects",
			});
		} finally {
			fetchStub.restore();
		}
		expect(calls).toBe(6);
	});

	it("enforces the plugins.http.allowedDomains allowlist", async () => {
		const stub = stubMethod(systemSettingsStore, "get", () => "allowed.example");
		try {
			await expect(guardedPluginFetch("http://evil.example/x")).rejects.toMatchObject({
				category: "forbidden",
				code: "plugin.http.host_not_allowed",
			});
		} finally {
			stub.restore();
		}
	});

	it("allows plain http to a public address", async () => {
		const calls: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			if (input instanceof URL) calls.push(input.href);
			else if (typeof input === "string") calls.push(input);
			else calls.push(input.url);

			return Promise.resolve(new Response("ok"));
		}) as typeof fetch;

		await guardedPluginFetch("http://1.1.1.1/media");
		expect(calls).toEqual(["http://1.1.1.1/media"]);
	});
});

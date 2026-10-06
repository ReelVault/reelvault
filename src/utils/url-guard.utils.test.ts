import { afterEach, describe, expect, test } from "bun:test";
import { guardedFetch, isPublicAddress, pinUrlToAddress } from "./url-guard.utils";

describe("isPublicAddress (IPv6)", () => {
	test("allows global-unicast addresses", () => {
		expect(isPublicAddress("2606:4700:10::6814:179a")).toBe(true);
		expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
	});

	test("rejects 6to4 and Teredo ranges that embed an IPv4 literal", () => {
		expect(isPublicAddress("2002:7f00:1::")).toBe(false);
		expect(isPublicAddress("2002:a9fe:a9fe::")).toBe(false);
		expect(isPublicAddress("2001::")).toBe(false);
		expect(isPublicAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(false);
	});

	test("rejects documentation and newly reserved ranges", () => {
		expect(isPublicAddress("2001:db8::1")).toBe(false);
		expect(isPublicAddress("2001:2::1")).toBe(false);
		expect(isPublicAddress("3fff::1")).toBe(false);
		expect(isPublicAddress("5f00::1")).toBe(false);
	});

	test("rejects an IPv4-mapped loopback", () => {
		expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
	});
});

describe("pinUrlToAddress", () => {
	test("rewrites the host to the vetted IPv4 and preserves port/path/query", () => {
		expect(pinUrlToAddress(new URL("https://example.com:8443/a/b?c=1"), "104.20.23.154")).toBe("https://104.20.23.154:8443/a/b?c=1");
	});

	test("brackets IPv6 addresses", () => {
		expect(pinUrlToAddress(new URL("https://example.com/x"), "2606:4700::1")).toBe("https://[2606:4700::1]/x");
	});
});

describe("guardedFetch", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	interface RecordedCall {
		url: string;
		headers: Headers;
	}

	function requestUrl(input: RequestInfo | URL): string {
		if (input instanceof URL) return input.href;
		if (typeof input === "string") return input;

		return input.url;
	}

	/** Replaces global fetch with an offline stub — IP-literal hosts never hit DNS. */
	function stubFetch(handler: (url: string) => Response): RecordedCall[] {
		const calls: RecordedCall[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			calls.push({ url, headers: new Headers(init?.headers) });

			return Promise.resolve(handler(url));
		}) as typeof fetch;

		return calls;
	}

	test("requires https unless the caller opts into more schemes", async () => {
		await expect(guardedFetch("http://1.1.1.1/file")).rejects.toThrow("Only https downloads are allowed");

		const calls = stubFetch(() => new Response("ok"));
		await guardedFetch("http://1.1.1.1/file", { allowedProtocols: ["http:", "https:"] });
		expect(calls.map((call) => call.url)).toEqual(["http://1.1.1.1/file"]);
	});

	test("pins the connection to the vetted address and keeps the real Host header", async () => {
		const calls = stubFetch(() => new Response("ok"));

		await guardedFetch("https://1.1.1.1:8443/path?q=1");

		expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1:8443/path?q=1"]);
		expect(calls[0]?.headers.get("host")).toBe("1.1.1.1:8443");
	});

	test("normalizes bracketed IPv6 hosts for the lookup and the extra predicate", async () => {
		const seen: string[] = [];
		const calls = stubFetch(() => new Response("ok"));

		await guardedFetch("https://[2606:4700:4700::1111]/x", { assertHostAllowed: (host) => seen.push(host) });

		expect(seen).toEqual(["2606:4700:4700::1111"]);
		expect(calls.map((call) => call.url)).toEqual(["https://[2606:4700:4700::1111]/x"]);
	});

	test("applies the extra host predicate before any request", async () => {
		const calls = stubFetch(() => new Response("ok"));

		await expect(
			guardedFetch("https://1.1.1.1/", {
				assertHostAllowed: () => {
					throw new Error("blocked by policy");
				},
			}),
		).rejects.toThrow("blocked by policy");
		expect(calls).toHaveLength(0);
	});

	test("rejects credentials embedded in the URL", async () => {
		await expect(guardedFetch("https://user:pass@1.1.1.1/")).rejects.toThrow("must not contain credentials");
	});

	test("rejects hosts that resolve to non-public addresses", async () => {
		await expect(guardedFetch("https://127.0.0.1/")).rejects.toThrow("resolves to a non-public address");
	});

	test("strips credential headers on cross-origin redirects", async () => {
		const calls = stubFetch((url) =>
			url.startsWith("https://1.1.1.1/")
				? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/next" } })
				: new Response("ok"),
		);

		await guardedFetch("https://1.1.1.1/start", { headers: { authorization: "Bearer secret", "x-custom": "keep" } });

		expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/start", "https://8.8.8.8/next"]);
		expect(calls[1]?.headers.get("authorization")).toBeNull();
		expect(calls[1]?.headers.get("x-custom")).toBe("keep");
	});

	test("enforces the redirect limit", async () => {
		const calls = stubFetch(() => new Response(null, { status: 302, headers: { location: "/again" } }));

		await expect(guardedFetch("https://1.1.1.1/start", { maxRedirects: 1 })).rejects.toThrow("Too many download redirects");
		expect(calls).toHaveLength(2);
	});
});

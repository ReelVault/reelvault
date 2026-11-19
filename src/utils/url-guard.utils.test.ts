import { afterEach, describe, expect, test } from "bun:test";
import { stubFetch } from "../../tests/helpers/fetch-stub.helper";
import { guardedFetch, isPublicAddress, pinUrlToAddress, unwrapIpv4Mapped } from "./url-guard.utils";

const PUBLIC_IPV4 = ["1.1.1.1", "8.8.8.8", "104.20.23.154", "172.32.0.1", "192.169.0.1", "198.20.0.1"];
const NON_PUBLIC_IPV4 = [
	"0.0.0.0",
	"0.255.255.255",
	"10.0.0.0",
	"10.255.255.255",
	"100.64.0.0",
	"100.127.255.255",
	"127.0.0.0",
	"127.255.255.255",
	"169.254.0.0",
	"169.254.255.255",
	"172.16.0.0",
	"172.31.255.255",
	"192.0.0.0",
	"192.0.0.255",
	"192.0.2.0",
	"192.0.2.255",
	"192.88.99.0",
	"192.88.99.255",
	"192.168.0.0",
	"192.168.255.255",
	"198.18.0.0",
	"198.19.255.255",
	"198.51.100.0",
	"198.51.100.255",
	"203.0.113.0",
	"203.0.113.255",
	"224.0.0.0",
	"239.255.255.255",
	"240.0.0.0",
	"255.255.255.255",
];
const PUBLIC_IPV6 = ["2606:4700:10::6814:179a", "2001:4860:4860::8888", "2000::1", "2001:1::1", "2400:cb00::1", "3000::1", "3ffe::1"];
const NON_PUBLIC_IPV6 = [
	"::",
	"::1",
	"fc00::1",
	"fdff:ffff::1",
	"fe80::1",
	"ff02::1",
	"2001:db8::1",
	"2001:2::1",
	"2001::1",
	"2001:0:4136:e378:8000:63bf:3fff:fdd2",
	"2002::1",
	"2002:7f00:1::",
	"1fff::1",
	"3fff::1",
	"3fff:ffff::1",
	"4000::1",
	"5f00::1",
];

describe("isPublicAddress (IPv4)", () => {
	test("allows publicly routable IPv4 addresses", () => {
		for (const ip of PUBLIC_IPV4) expect(isPublicAddress(ip)).toBe(true);
	});

	test("rejects every reserved IPv4 range at both boundaries", () => {
		for (const ip of NON_PUBLIC_IPV4) expect(isPublicAddress(ip)).toBe(false);
	});

	test("classifies IPv4-mapped IPv6 by the embedded address", () => {
		expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
		expect(isPublicAddress("::FFFF:8.8.8.8")).toBe(true);
		expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
		expect(isPublicAddress("x::ffff:8.8.8.8")).toBe(false);
		expect(isPublicAddress("::ffff:8.8.8.8x")).toBe(false);
	});

	test("rejects strings that are not IP addresses", () => {
		expect(isPublicAddress("not-an-ip")).toBe(false);
		expect(isPublicAddress("")).toBe(false);
	});
});

describe("isPublicAddress (IPv6)", () => {
	test("allows global-unicast addresses", () => {
		for (const ip of PUBLIC_IPV6) expect(isPublicAddress(ip)).toBe(true);
	});

	test("rejects 6to4, Teredo, documentation and reserved ranges", () => {
		for (const ip of NON_PUBLIC_IPV6) expect(isPublicAddress(ip)).toBe(false);
	});

	test("rejects a zone-id suffix", () => {
		expect(isPublicAddress("fe80::1%eth0")).toBe(false);
	});
});

describe("unwrapIpv4Mapped", () => {
	test("returns the embedded IPv4 address of an IPv4-mapped literal in any letter case", () => {
		expect(unwrapIpv4Mapped("::ffff:10.0.0.1")).toBe("10.0.0.1");
		expect(unwrapIpv4Mapped("::FFFF:8.8.8.8")).toBe("8.8.8.8");
	});

	test("returns undefined for addresses that are not IPv4-mapped", () => {
		expect(unwrapIpv4Mapped("2001:db8::1")).toBeUndefined();
		expect(unwrapIpv4Mapped("x::ffff:8.8.8.8")).toBeUndefined();
		expect(unwrapIpv4Mapped("::ffff:8.8.8.8x")).toBeUndefined();
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

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("guardedFetch", () => {
	test("requires https unless the caller opts into more schemes", async () => {
		await expect(guardedFetch("http://1.1.1.1/file")).rejects.toMatchObject({
			category: "validation",
			code: "download.unsupported_protocol",
		});

		const calls = stubFetch(() => new Response("ok"));
		await guardedFetch("http://1.1.1.1/file", { allowedProtocols: ["http:", "https:"] });
		expect(calls.map((call) => call.url)).toEqual(["http://1.1.1.1/file"]);
	});

	test("pins the connection to the vetted address and keeps the real Host header", async () => {
		const calls = stubFetch(() => new Response("ok"));

		await guardedFetch("https://1.1.1.1:8443/path?q=1");

		expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1:8443/path?q=1"]);
		expect(calls[0]?.headers.get("host")).toBe("1.1.1.1:8443");
		expect(calls[0]?.tls).toEqual({ serverName: "1.1.1.1" });
	});

	test("normalizes bracketed IPv6 hosts for the lookup and the extra predicate", async () => {
		const seen: string[] = [];
		const calls = stubFetch(() => new Response("ok"));

		await guardedFetch("https://[2606:4700:4700::1111]/x", { assertHostAllowed: (host) => seen.push(host) });

		expect(seen).toEqual(["2606:4700:4700::1111"]);
		expect(calls.map((call) => call.url)).toEqual(["https://[2606:4700:4700::1111]/x"]);
	});

	test("applies the extra host predicate before any request", async () => {
		const policyError = new Error("blocked by policy");
		const calls = stubFetch(() => new Response("ok"));

		await expect(
			guardedFetch("https://1.1.1.1/", {
				assertHostAllowed: () => {
					throw policyError;
				},
			}),
		).rejects.toBe(policyError);
		expect(calls).toHaveLength(0);
	});

	test("rejects credentials embedded in the URL", async () => {
		await expect(guardedFetch("https://user:pass@1.1.1.1/")).rejects.toMatchObject({
			category: "validation",
			code: "download.invalid_url",
		});
		await expect(guardedFetch("https://user@1.1.1.1/")).rejects.toMatchObject({
			category: "validation",
			code: "download.invalid_url",
		});
		await expect(guardedFetch("https://:pass@1.1.1.1/")).rejects.toMatchObject({
			category: "validation",
			code: "download.invalid_url",
		});
	});

	test("rejects a malformed URL", async () => {
		await expect(guardedFetch("not a url")).rejects.toMatchObject({
			category: "validation",
			code: "download.invalid_url",
		});
	});

	test("treats an explicit empty protocol list as no allowed protocol", async () => {
		await expect(guardedFetch("https://1.1.1.1/", { allowedProtocols: [] })).rejects.toMatchObject({
			category: "validation",
			code: "download.unsupported_protocol",
		});
	});

	test("rejects hosts that resolve to non-public addresses", async () => {
		await expect(guardedFetch("https://127.0.0.1/")).rejects.toMatchObject({ category: "validation", code: "download.host_blocked" });
	});

	test("strips every credential header on cross-origin redirects", async () => {
		const calls = stubFetch((url) =>
			url.startsWith("https://1.1.1.1/")
				? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/next" } })
				: new Response("ok"),
		);
		const credentials = {
			authorization: "Bearer secret",
			cookie: "session=secret",
			"proxy-authorization": "Basic secret",
			"x-api-key": "api-secret",
			"x-auth-token": "auth-secret",
			"x-goog-api-key": "google-secret",
			"x-custom": "keep",
		};

		await guardedFetch("https://1.1.1.1/start", { headers: credentials });

		expect(calls.map((call) => call.url)).toEqual(["https://1.1.1.1/start", "https://8.8.8.8/next"]);
		for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token", "x-goog-api-key"]) {
			expect(calls[1]?.headers.get(name)).toBeNull();
		}
		expect(calls[1]?.headers.get("x-custom")).toBe("keep");
	});

	test("keeps credentials on a same-origin redirect", async () => {
		const calls = stubFetch((url) =>
			url.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "/next" } }) : new Response("ok"),
		);

		await guardedFetch("https://1.1.1.1/start", { headers: { authorization: "Bearer secret" } });

		expect(calls[1]?.headers.get("authorization")).toBe("Bearer secret");
	});
});

describe("guardedFetch redirects", () => {
	test("enforces the redirect limit", async () => {
		const calls = stubFetch(() => new Response(null, { status: 302, headers: { location: "/again" } }));

		await expect(guardedFetch("https://1.1.1.1/start", { maxRedirects: 1 })).rejects.toMatchObject({
			category: "validation",
			code: "download.too_many_redirects",
		});
		expect(calls).toHaveLength(2);
	});

	test("uses four redirect hops by default", async () => {
		const calls = stubFetch(() => new Response(null, { status: 302, headers: { location: "/again" } }));

		await expect(guardedFetch("https://1.1.1.1/start")).rejects.toMatchObject({
			category: "validation",
			code: "download.too_many_redirects",
		});
		expect(calls).toHaveLength(5);
	});

	test("follows no redirect when the limit is zero", async () => {
		const calls = stubFetch(() => new Response(null, { status: 302, headers: { location: "/again" } }));

		await expect(guardedFetch("https://1.1.1.1/start", { maxRedirects: 0 })).rejects.toMatchObject({
			category: "validation",
			code: "download.too_many_redirects",
		});
		expect(calls).toHaveLength(1);
	});

	test.each([301, 302, 303])("downgrades a POST after a %p redirect", async (status) => {
		const calls = stubFetch((url) =>
			url.startsWith("https://1.1.1.1/")
				? new Response(null, { status, headers: { location: "https://8.8.8.8/next" } })
				: new Response("ok"),
		);

		await guardedFetch("https://1.1.1.1/start", { method: "POST", body: "payload" });

		expect(calls[1]?.method).toBe("GET");
		expect(calls[1]?.body).toBeNull();
	});

	test.each([307, 308])("keeps a POST after a %p redirect", async (status) => {
		const calls = stubFetch((url) =>
			url.startsWith("https://1.1.1.1/")
				? new Response(null, { status, headers: { location: "https://8.8.8.8/next" } })
				: new Response("ok"),
		);

		await guardedFetch("https://1.1.1.1/start", { method: "POST", body: "payload" });

		expect(calls[1]?.method).toBe("POST");
		expect(calls[1]?.body).toBe("payload");
	});

	test("keeps HEAD after a 301 redirect", async () => {
		const calls = stubFetch((url) =>
			url.startsWith("https://1.1.1.1/")
				? new Response(null, { status: 301, headers: { location: "https://8.8.8.8/next" } })
				: new Response("ok"),
		);

		await guardedFetch("https://1.1.1.1/start", { method: "HEAD" });

		expect(calls[1]?.method).toBe("HEAD");
	});

	test("keeps the default GET after a 307 redirect", async () => {
		const calls = stubFetch((url) =>
			url.startsWith("https://1.1.1.1/")
				? new Response(null, { status: 307, headers: { location: "https://8.8.8.8/next" } })
				: new Response("ok"),
		);

		await guardedFetch("https://1.1.1.1/start");

		expect(calls[1]?.method).toBe("GET");
	});

	test.each([300, 304, 305, 306])("returns a %p response without following it", async (status) => {
		const calls = stubFetch(() => new Response(null, { status, headers: { location: "https://8.8.8.8/next" } }));

		const response = await guardedFetch("https://1.1.1.1/start");

		expect(response.status).toBe(status);
		expect(calls).toHaveLength(1);
	});
});

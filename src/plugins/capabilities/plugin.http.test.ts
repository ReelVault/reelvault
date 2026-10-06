import { afterEach, describe, expect, it } from "bun:test";
import { systemSettingsService } from "@/application/admin/system-settings.service";
import { isPublicAddress } from "@/utils/url-guard.utils";
import { stubMethod } from "../../../tests/helpers/method-stub";
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

describe("isPublicAddress", () => {
	it("rejects loopback, private, link-local, CGNAT and reserved IPv4", () => {
		for (const ip of [
			"127.0.0.1",
			"10.0.0.5",
			"192.168.1.1",
			"172.16.9.9",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"255.255.255.255",
		]) {
			expect(isPublicAddress(ip)).toBeFalse();
		}
	});

	it("allows public IPv4", () => {
		expect(isPublicAddress("1.1.1.1")).toBeTrue();
		expect(isPublicAddress("8.8.8.8")).toBeTrue();
	});

	it("rejects loopback, ULA, link-local, documentation and IPv4-mapped IPv6", () => {
		for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
			expect(isPublicAddress(ip)).toBeFalse();
		}
	});

	it("allows global-unicast IPv6", () => {
		expect(isPublicAddress("2606:4700:4700::1111")).toBeTrue();
		expect(isPublicAddress("2001:4860:4860::8888")).toBeTrue();
	});
});

describe("guardedPluginFetch", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("rejects local hosts before any request", async () => {
		await expect(guardedPluginFetch("http://localhost/x")).rejects.toThrow("local host is not allowed");
	});

	it("enforces the plugins.http.allowedDomains allowlist", async () => {
		const stub = stubMethod(systemSettingsService, "get", () => "allowed.example");
		try {
			await expect(guardedPluginFetch("http://evil.example/x")).rejects.toThrow("not on the plugins.http.allowedDomains allowlist");
		} finally {
			stub.restore();
		}
	});

	it("pins allowlisted http hosts to their vetted address", async () => {
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

import { describe, expect, it } from "bun:test";
import { isPublicAddress } from "@/utils/url-guard.utils";
import { isHostAllowed } from "./plugin.http";

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

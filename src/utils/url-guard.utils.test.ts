import { describe, expect, test } from "bun:test";
import { isPublicAddress, pinUrlToAddress } from "./url-guard.utils";

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

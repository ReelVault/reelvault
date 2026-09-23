import { describe, expect, it } from "bun:test";
import { escapeRegex, isLocalNetworkHost, isOriginAllowed, parseAllowedOrigins, wildcardPatternToRegex } from "./http.utils";

describe("http.utils", () => {
	describe("escapeRegex", () => {
		it("escapes special regex characters", () => {
			expect(escapeRegex("hello.world*foo?")).toBe("hello\\.world\\*foo\\?");
			expect(escapeRegex("a+b(c)[d]{e}^f$g|h\\i")).toBe("a\\+b\\(c\\)\\[d\\]\\{e\\}\\^f\\$g\\|h\\\\i");
		});
	});
	describe("parseAllowedOrigins", () => {
		it("parses comma-separated origins and trims spaces", () => {
			const parsed = parseAllowedOrigins("http://localhost:3000, http://reelvault.lan:3000 , https://custom.domain.com");
			expect(parsed).toEqual(["http://localhost:3000", "http://reelvault.lan:3000", "https://custom.domain.com"]);
		});

		it("accepts an array of origins", () => {
			const parsed = parseAllowedOrigins(["http://localhost:3000", " http://*.ts:* "]);
			expect(parsed).toEqual(["http://localhost:3000", "http://*.ts:*"]);
		});

		it("handles empty or undefined values gracefully", () => {
			expect(parseAllowedOrigins(undefined)).toEqual([]);
			expect(parseAllowedOrigins("")).toEqual([]);
			expect(parseAllowedOrigins([])).toEqual([]);
		});
	});

	describe("isLocalNetworkHost", () => {
		it("identifies loopback hosts", () => {
			expect(isLocalNetworkHost("localhost")).toBe(true);
			expect(isLocalNetworkHost("127.0.0.1")).toBe(true);
			expect(isLocalNetworkHost("::1")).toBe(true);
		});

		it("identifies private IPv4 addresses (RFC 1918)", () => {
			expect(isLocalNetworkHost("192.168.1.20")).toBe(true);
			expect(isLocalNetworkHost("192.168.0.1")).toBe(true);
			expect(isLocalNetworkHost("10.0.0.5")).toBe(true);
			expect(isLocalNetworkHost("10.254.1.1")).toBe(true);
			expect(isLocalNetworkHost("172.16.0.10")).toBe(true);
			expect(isLocalNetworkHost("172.24.1.1")).toBe(true);
			expect(isLocalNetworkHost("172.31.255.255")).toBe(true);
		});

		it("identifies local domain suffixes", () => {
			expect(isLocalNetworkHost("reelvault.lan")).toBe(true);
			expect(isLocalNetworkHost("sub.nas.lan")).toBe(true);
			expect(isLocalNetworkHost("server.local")).toBe(true);
			expect(isLocalNetworkHost("mybox.home")).toBe(true);
			expect(isLocalNetworkHost("vault.home.arpa")).toBe(true);
			expect(isLocalNetworkHost("app.internal")).toBe(true);
		});

		it("rejects public domains and public IP addresses", () => {
			expect(isLocalNetworkHost("google.com")).toBe(false);
			expect(isLocalNetworkHost("8.8.8.8")).toBe(false);
			expect(isLocalNetworkHost("1.1.1.1")).toBe(false);
			expect(isLocalNetworkHost("mycustomdomain.org")).toBe(false);
			expect(isLocalNetworkHost("172.32.0.1")).toBe(false);
			expect(isLocalNetworkHost("172.15.0.1")).toBe(false);
		});
	});

	describe("wildcardPatternToRegex", () => {
		it("matches custom Tailscale / VPN patterns with ports", () => {
			const regex = wildcardPatternToRegex("http://*.ts:*");
			expect(regex.test("http://reelvault.ts:3000")).toBe(true);
			expect(regex.test("http://my-node.ts:8080")).toBe(true);
			expect(regex.test("https://reelvault.ts:3000")).toBe(false);
		});

		it("matches any protocol wildcard patterns", () => {
			const regex = wildcardPatternToRegex("*://reelvault.lan:*");
			expect(regex.test("http://reelvault.lan:3000")).toBe(true);
			expect(regex.test("https://reelvault.lan:443")).toBe(true);
			expect(regex.test("http://other.lan:3000")).toBe(false);
		});
	});

	describe("isOriginAllowed", () => {
		it("allows local LAN and Pi-hole DNS origins by default", () => {
			expect(isOriginAllowed("http://localhost:3000")).toBe(true);
			expect(isOriginAllowed("http://127.0.0.1:3000")).toBe(true);
			expect(isOriginAllowed("http://192.168.1.20:3000")).toBe(true);
			expect(isOriginAllowed("http://reelvault.lan:3000")).toBe(true);
			expect(isOriginAllowed("http://server.local:3000")).toBe(true);
		});

		it("allows Tauri desktop custom-protocol origins", () => {
			expect(isOriginAllowed("tauri://localhost")).toBe(true);
			expect(isOriginAllowed("http://tauri.localhost")).toBe(true);
		});

		it("allows Capacitor shell origins (Android appId host, iOS capacitor scheme)", () => {
			expect(isOriginAllowed("https://pl.reelvault.mobile")).toBe(true);
			expect(isOriginAllowed("capacitor://localhost")).toBe(true);
			// A foreign https origin is NOT covered by the appId-host rule.
			expect(isOriginAllowed("https://evil.reelvault.mobile.example.com")).toBe(false);
		});

		it("allows origins matching explicit rules", () => {
			expect(isOriginAllowed("http://my-node.ts:3000", ["http://*.ts:*"])).toBe(true);
			expect(isOriginAllowed("https://mojadomena.pl", ["https://mojadomena.pl"])).toBe(true);
		});

		it("rejects untrusted external domains when not configured", () => {
			expect(isOriginAllowed("https://malicious-site.com")).toBe(false);
			expect(isOriginAllowed("http://untrusted-public-ip.com:3000")).toBe(false);
			expect(isOriginAllowed(null)).toBe(false);
			expect(isOriginAllowed("")).toBe(false);
		});
	});
});

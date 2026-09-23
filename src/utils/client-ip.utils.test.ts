import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { clientIpMiddleware } from "@/middleware/client-ip.middleware";
import { CLIENT_IP_HEADER, normalizeIp, resolveClientIp } from "./client-ip.utils";

describe("normalizeIp", () => {
	test("unwraps IPv4-mapped IPv6 and bracketed IPv6", () => {
		expect(normalizeIp("::ffff:10.0.0.5")).toBe("10.0.0.5");
		expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
		expect(normalizeIp(" 192.0.2.10 ")).toBe("192.0.2.10");
	});

	test("rejects anything that is not an IP", () => {
		expect(normalizeIp("evil.example")).toBeNull();
		expect(normalizeIp("999.1.1.1")).toBeNull();
		expect(normalizeIp("")).toBeNull();
		expect(normalizeIp(null)).toBeNull();
	});
});

describe("resolveClientIp", () => {
	test("ignores X-Forwarded-For entirely without trusted proxies", () => {
		expect(resolveClientIp({ remoteAddress: "::ffff:203.0.113.9", forwardedFor: "1.2.3.4", trustedProxyCount: 0 })).toBe("203.0.113.9");
		expect(resolveClientIp({ remoteAddress: null, forwardedFor: "1.2.3.4", trustedProxyCount: 0 })).toBeNull();
	});

	test("takes the hop attested by the single trusted proxy, not the client-written one", () => {
		expect(resolveClientIp({ remoteAddress: "10.0.0.1", forwardedFor: "203.0.113.9", trustedProxyCount: 1 })).toBe("203.0.113.9");
		expect(resolveClientIp({ remoteAddress: "10.0.0.1", forwardedFor: "1.2.3.4, 203.0.113.9", trustedProxyCount: 1 })).toBe("203.0.113.9");
	});

	test("walks past every trusted proxy hop", () => {
		const forwardedFor = "1.2.3.4, 203.0.113.9, 198.51.100.1";
		expect(resolveClientIp({ remoteAddress: "10.0.0.1", forwardedFor, trustedProxyCount: 2 })).toBe("203.0.113.9");
	});

	test("falls back to the peer when the chain is shorter than the trusted proxy count", () => {
		expect(resolveClientIp({ remoteAddress: "10.0.0.1", forwardedFor: "203.0.113.9", trustedProxyCount: 2 })).toBe("10.0.0.1");
	});

	test("falls back to the peer when the attested hop is not an IP", () => {
		expect(resolveClientIp({ remoteAddress: "10.0.0.1", forwardedFor: "1.2.3.4, not-an-ip", trustedProxyCount: 1 })).toBe("10.0.0.1");
	});
});

describe("clientIpMiddleware", () => {
	test("strips a client-supplied trusted header instead of honouring it", async () => {
		const app = new Elysia().use(clientIpMiddleware).get("/ip", ({ request }) => request.headers.get(CLIENT_IP_HEADER) ?? "none");

		const response = await app.handle(new Request("http://localhost/ip", { headers: { [CLIENT_IP_HEADER]: "1.2.3.4" } }));

		// No socket in app.handle, so nothing trustworthy can be stamped either.
		expect(await response.text()).toBe("none");
	});
});

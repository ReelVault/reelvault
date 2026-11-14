import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@/config/env.config";
import { getCookieDomainFromOrigin, rewriteCookieDomain } from "./cookie-domain.utils";

const originalCookieDomain = env.APP_COOKIE_DOMAIN;

afterEach(() => {
	env.APP_COOKIE_DOMAIN = originalCookieDomain;
});

function responseWithCookies(cookies: string[], status = 200): Response {
	const headers = new Headers();
	headers.set("content-type", "text/plain");
	for (const cookie of cookies) headers.append("set-cookie", cookie);

	return new Response("body", { status, headers });
}

function cookiesOf(response: Response): string[] {
	return response.headers.getSetCookie();
}

describe("getCookieDomainFromOrigin", () => {
	test("scopes a trusted .lan origin to its hostname", () => {
		expect(getCookieDomainFromOrigin("https://rv.lan")).toBe(".rv.lan");
	});

	test("scopes a trusted nested .lan hostname", () => {
		expect(getCookieDomainFromOrigin("https://api.rv.lan:8443")).toBe(".api.rv.lan");
	});

	test("does not treat a hostname that merely starts with an IPv4 address as a raw IP", () => {
		expect(getCookieDomainFromOrigin("https://1.2.3.4.lan")).toBe(".1.2.3.4.lan");
	});

	test("returns undefined for missing, malformed and untrusted origins", () => {
		expect(getCookieDomainFromOrigin(null)).toBeUndefined();
		expect(getCookieDomainFromOrigin(undefined)).toBeUndefined();
		expect(getCookieDomainFromOrigin("not a url")).toBeUndefined();
		expect(getCookieDomainFromOrigin("https://evil.example")).toBeUndefined();
	});

	test("returns undefined for loopback and raw IPv4 origins", () => {
		expect(getCookieDomainFromOrigin("http://localhost:3000")).toBeUndefined();
		expect(getCookieDomainFromOrigin("https://127.0.0.1")).toBeUndefined();
		expect(getCookieDomainFromOrigin("http://192.168.0.42:3000")).toBeUndefined();
	});

	test("uses APP_COOKIE_DOMAIN as an explicit override", () => {
		env.APP_COOKIE_DOMAIN = ".override.example";

		expect(getCookieDomainFromOrigin("https://evil.example")).toBe(".override.example");
		expect(getCookieDomainFromOrigin(null)).toBe(".override.example");
	});
});

describe("rewriteCookieDomain", () => {
	test("adds the derived domain to every Set-Cookie header", () => {
		const response = responseWithCookies(["session=abc; Path=/; HttpOnly", "refresh=def; Path=/; HttpOnly"], 201);

		const rewritten = rewriteCookieDomain(response, "https://rv.lan");

		expect(rewritten.status).toBe(201);
		expect(cookiesOf(rewritten)).toEqual([
			"session=abc; Path=/; HttpOnly; Domain=.rv.lan",
			"refresh=def; Path=/; HttpOnly; Domain=.rv.lan",
		]);
	});

	test("keeps a cookie that already has a domain attribute", () => {
		const response = responseWithCookies(["session=abc; Domain=.existing.lan; Path=/"]);

		const rewritten = rewriteCookieDomain(response, "https://rv.lan");

		expect(cookiesOf(rewritten)).toEqual(["session=abc; Domain=.existing.lan; Path=/"]);
	});

	test("keeps a domain attribute written without whitespace after the separator", () => {
		const response = responseWithCookies(["session=abc;Domain=.existing.lan; Path=/"]);

		const rewritten = rewriteCookieDomain(response, "https://rv.lan");

		expect(cookiesOf(rewritten)).toEqual(["session=abc;Domain=.existing.lan; Path=/"]);
	});

	test("recognises the domain attribute case-insensitively", () => {
		const response = responseWithCookies(["session=abc; dOmAiN=.existing.lan; Path=/"]);

		const rewritten = rewriteCookieDomain(response, "https://rv.lan");

		expect(cookiesOf(rewritten)).toEqual(["session=abc; dOmAiN=.existing.lan; Path=/"]);
	});

	test("does not treat a lookalike attribute as an existing domain", () => {
		const response = responseWithCookies(["session=abc; X-Domain=.lookalike.lan; Path=/"]);

		const rewritten = rewriteCookieDomain(response, "https://rv.lan");

		expect(cookiesOf(rewritten)).toEqual(["session=abc; X-Domain=.lookalike.lan; Path=/; Domain=.rv.lan"]);
	});

	test("leaves a response without cookies unchanged", () => {
		const response = responseWithCookies([]);

		const rewritten = rewriteCookieDomain(response, "https://rv.lan");

		expect(rewritten).toBe(response);
		expect(cookiesOf(rewritten)).toEqual([]);
	});

	test("leaves a response unchanged when the origin has no cookie domain", () => {
		const response = responseWithCookies(["session=abc; Path=/"]);

		expect(cookiesOf(rewriteCookieDomain(response, "https://evil.example"))).toEqual(["session=abc; Path=/"]);
		expect(cookiesOf(rewriteCookieDomain(response, "http://localhost:3000"))).toEqual(["session=abc; Path=/"]);
		expect(cookiesOf(rewriteCookieDomain(response, "http://192.168.0.42:3000"))).toEqual(["session=abc; Path=/"]);
	});

	test("uses the explicit APP_COOKIE_DOMAIN override for an untrusted origin", () => {
		env.APP_COOKIE_DOMAIN = ".override.example";
		const response = responseWithCookies(["session=abc; Path=/"]);

		const rewritten = rewriteCookieDomain(response, "https://evil.example");

		expect(cookiesOf(rewritten)).toEqual(["session=abc; Path=/; Domain=.override.example"]);
	});
});

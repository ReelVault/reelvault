import { describe, expect, test } from "bun:test";
import { CLIENT_IP_HEADER, getStampedClientIp } from "./client-ip.utils";

describe("stamped client ip", () => {
	test("reads the ip the middleware stamped on the request", () => {
		expect(getStampedClientIp(new Headers({ [CLIENT_IP_HEADER]: "192.0.2.10" }))).toBe("192.0.2.10");
	});

	test("ignores client-controlled forwarding headers", () => {
		expect(getStampedClientIp(new Headers({ "x-forwarded-for": "192.0.2.10, 198.51.100.4" }))).toBeNull();
		expect(getStampedClientIp(new Headers({ "x-real-ip": "192.0.2.20" }))).toBeNull();
	});

	test("is null when the request carries no stamped ip", () => {
		expect(getStampedClientIp(new Headers())).toBeNull();
		expect(getStampedClientIp(undefined)).toBeNull();
	});
});

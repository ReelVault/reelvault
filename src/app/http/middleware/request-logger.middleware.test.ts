import { describe, expect, test } from "bun:test";
import { status } from "elysia";
import { responseStatus } from "./request-logger.middleware";

describe("responseStatus", () => {
	test("a status(code, body) result is logged with the code it is sent with", () => {
		expect(responseStatus(status(202, { enqueued: 0 }), {})).toBe(202);
	});

	test("a Response is logged with its own status", () => {
		expect(responseStatus(new Response("created", { status: 201 }), {})).toBe(201);
	});

	test("a plain value is logged with the status set on the context, or 200 when none is set", () => {
		expect(responseStatus({ ok: true }, { status: 204 })).toBe(204);
		expect(responseStatus({ ok: true }, {})).toBe(200);
	});
});

import { afterAll, expect, test } from "bun:test";
import { installSessionStub, listApiRoutes, prepareSecuritySuite, send } from "./security.helper";

/**
 * Every bulk endpoint documents a maximum size (and most a minimum). Exceeding it must
 * be refused by validation with a 400 before any work starts, for every caller; the
 * limit itself must still be accepted. A route renamed or removed fails here first.
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());

const ids = (count: number, prefix = "id") => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

interface LimitCase {
	method: "POST" | "PUT" | "PATCH" | "DELETE";
	template: string;
	/** Builds the body with `count` items in the field under test. */
	body: (count: number) => Record<string, unknown>;
	/** Set when the route is safe to call with `limit` unknown ids (it changes nothing). */
	acceptsLimit?: boolean;
	role: "admin" | "user";
	max: number;
}

const LIMIT_CASES: LimitCase[] = [
	{
		method: "POST",
		template: "/v1/admin/trickplay/regenerate",
		body: (count) => ({ scope: "titles", ids: ids(count), force: false }),
		role: "admin",
		max: 50,
	},
	{
		method: "POST",
		template: "/v1/admin/users/sessions/revoke",
		body: (count) => ({ userIds: ids(count, "user") }),
		role: "admin",
		max: 100,
	},
	{ method: "POST", template: "/v1/media-files/bulk-delete", body: (count) => ({ ids: ids(count) }), role: "admin", max: 50 },
	{ method: "POST", template: "/v1/metadata/bulk-delete", body: (count) => ({ ids: ids(count) }), role: "admin", max: 50 },
	{
		method: "POST",
		template: "/v1/subtitles/bulk-delete",
		body: (count) => ({ ids: ids(count) }),
		acceptsLimit: true,
		role: "admin",
		max: 200,
	},
	{
		method: "POST",
		template: "/v1/admin/live-activity/terminate",
		body: (count) => ({ sessionIds: ids(count, "session"), reason: "limit test" }),
		acceptsLimit: true,
		role: "admin",
		max: 100,
	},
	{
		method: "POST",
		template: "/v1/admin/plugins/bulk",
		body: (count) => ({ enabled: true, pluginIds: ids(count, "plugin") }),
		role: "admin",
		max: 100,
	},
	{ method: "POST", template: "/v1/episodes/bulk-refresh", body: (count) => ({ ids: ids(count) }), role: "admin", max: 50 },
	{ method: "POST", template: "/v1/me/watchlist/bulk", body: (count) => ({ add: ids(count) }), role: "user", max: 500 },
	{ method: "POST", template: "/v1/me/watch-state/bulk", body: (count) => ({ mediaFileIds: ids(count) }), role: "user", max: 500 },
	{
		method: "POST",
		template: "/v1/notifications/delete",
		body: (count) => ({ ids: ids(count) }),
		acceptsLimit: true,
		role: "user",
		max: 200,
	},
];

const routes = listApiRoutes();

for (const limit of LIMIT_CASES) {
	test(`${limit.method} ${limit.template} refuses ${limit.max + 1} items as a bad request`, async () => {
		expect(routes.some((route) => route.method === limit.method && route.template === limit.template)).toBe(true);

		const response = await send(limit.method, limit.template, { role: limit.role, body: limit.body(limit.max + 1) });

		expect(response.status).toBe(400);
	});

	if (limit.acceptsLimit) {
		test(`${limit.method} ${limit.template} accepts exactly ${limit.max} items`, async () => {
			const response = await send(limit.method, limit.template, { role: limit.role, body: limit.body(limit.max) });

			expect(response.status).not.toBe(400);
			expect(response.status).toBeLessThan(500);
		});
	}
}

test("the watchlist status query refuses an oversized id list", async () => {
	const oversized = "x".repeat(2001);
	const response = await send("GET", `/v1/me/watchlist/statuses?metadataIds=${oversized}`, { role: "user" });

	expect(response.status).toBe(400);
});

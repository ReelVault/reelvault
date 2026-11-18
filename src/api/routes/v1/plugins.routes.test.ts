import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { clearRateLimitBuckets } from "@/api/middleware/rate-limit.middleware";
import { sessionResolver } from "@/services/auth/session-resolver.service";
import {
	type PluginRouteDispatchInput,
	type PluginRouteDispatchResult,
	pluginRouteDispatchService,
} from "@/services/plugins/plugin-route-dispatch.service";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { pluginsRoutes } from "./plugins.routes";

const app = new Elysia().use(domainErrorsMiddleware).use(pluginsRoutes);
const SESSION_COOKIE = "better-auth.session_token=user-token";
const stubs: Array<{ restore(): void }> = [];

let activeProfile: { id: string } | null;

beforeEach(() => {
	clearRateLimitBuckets();
	activeProfile = null;
	stubs.push(
		stubMethod(sessionResolver, "fromSessionCookie", () =>
			Promise.resolve({ user: { id: "user-1", role: "admin" }, session: null, profile: activeProfile }),
		),
	);
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

afterAll(() => clearRateLimitBuckets());

async function signedRequest(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("cookie", SESSION_COOKIE);

	return await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
}

function stubDispatch(result: PluginRouteDispatchResult | ((input: PluginRouteDispatchInput) => PluginRouteDispatchResult)): void {
	stubs.push(
		stubMethod(pluginRouteDispatchService, "dispatch", (input: PluginRouteDispatchInput) =>
			Promise.resolve(typeof result === "function" ? result(input) : result),
		),
	);
}

test("plugin dispatch rejects an unauthenticated request before it reaches a plugin", async () => {
	const response = await app.handle(new Request("http://localhost/plugins/org.example.menu/items"));

	expect(response.status).toBe(401);
});

test("forwards safe plugin headers and drops hop-by-hop ones", async () => {
	stubDispatch({
		type: "success",
		status: 200,
		body: { ok: true },
		headers: { "set-cookie": "session=leak", upgrade: "websocket", "x-plugin-version": "2.1" },
	});

	const response = await signedRequest("/plugins/org.example.menu/items");

	expect(response.status).toBe(200);
	expect(response.headers.get("set-cookie")).toBeNull();
	expect(response.headers.get("upgrade")).toBeNull();
	expect(response.headers.get("x-plugin-version")).toBe("2.1");
});

test("maps a forbidden plugin route to the forbidden API envelope", async () => {
	stubDispatch({ type: "forbidden", message: "not allowed" });

	const response = await signedRequest("/plugins/org.example.menu/items");
	const payload = (await response.json()) as { statusCode: number; code: string };

	expect(response.status).toBe(403);
	expect(payload).toMatchObject({ statusCode: 403, code: "plugin.route_forbidden" });
});

test("maps an invalid plugin request to the validation API envelope", async () => {
	stubDispatch({ type: "invalid_request", message: "bad body" });

	const response = await signedRequest("/plugins/org.example.menu/items", { method: "POST" });
	const payload = (await response.json()) as { statusCode: number; code: string };

	expect(response.status).toBe(400);
	expect(payload).toMatchObject({ statusCode: 400, code: "plugin.route_request_invalid" });
});

test("parses a JSON body the framework left unparsed", async () => {
	stubDispatch((input: PluginRouteDispatchInput) => ({ type: "success" as const, status: 200, body: input.body ?? null }));

	const response = await signedRequest("/plugins/org.example.menu/items", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ count: 7 }),
	});

	expect(await response.json()).toEqual({ count: 7 });
});

test("does not interpret a body without a JSON content type as JSON", async () => {
	stubDispatch((input: PluginRouteDispatchInput) => ({ type: "success" as const, status: 200, body: input.body ?? null }));

	const response = await signedRequest("/plugins/org.example.menu/items", {
		method: "POST",
		body: '{"count":7}',
	});

	expect(await response.text()).toBe("");
});

test("passes the active profile id to the plugin user context", async () => {
	activeProfile = { id: "profile-7" };
	stubDispatch((input: PluginRouteDispatchInput) => ({ type: "success" as const, status: 200, body: input.user.profileId ?? null }));

	const response = await signedRequest("/plugins/org.example.menu/items");

	expect(await response.text()).toBe("profile-7");
});

test("gives each plugin its own rate-limit bucket", async () => {
	stubDispatch((input: PluginRouteDispatchInput) => ({ type: "success" as const, status: 200, body: input.pluginId }));

	const first = await signedRequest("/plugins/plugin-a/items");
	const limit = Number(first.headers.get("X-RateLimit-Limit"));
	for (let request = 1; request < limit; request++) await signedRequest("/plugins/plugin-a/items");

	const exhausted = await signedRequest("/plugins/plugin-a/items");
	expect(exhausted.status).toBe(429);

	const otherPlugin = await signedRequest("/plugins/plugin-b/items");
	expect(otherPlugin.status).toBe(200);
	expect(await otherPlugin.text()).toBe("plugin-b");
});

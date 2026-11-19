import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { profilesRepository } from "@/repositories/profiles.repository";
import { pluginAccessBus } from "@/system/extensions/plugin.access";
import { stubSignedInSession } from "../../../../tests/helpers/better-auth-session.helper";
import type { MethodStub } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";

const { meRoutes } = await import("./me.routes");
const app = new Elysia().use(domainErrorsMiddleware).use(meRoutes);
const { client } = useTestDatabase();

const stubs: MethodStub[] = [];
const unregisterPolicies: Array<() => void> = [];

beforeEach(async () => {
	// The auth hot path caches profile rows process-wide; a fresh per-test database must not read a copy another test left behind.
	profilesRepository.invalidateCached("profile-1");
	await client().insert(schema.users).values({ id: "user-1", name: "User", email: "user@example.com", emailVerified: true });
	await client().insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Ada" });
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	for (const unregister of unregisterPolicies.splice(0)) unregister();
	profilesRepository.invalidateCached("profile-1");
});

test("GET /me answers before a profile is selected", async () => {
	stubs.push(stubSignedInSession("user-1"));

	const response = await app.handle(new Request("http://localhost/me/", { headers: { authorization: "Bearer test" } }));

	expect(response.status).toBe(200);
	const body = (await response.json()) as { user: { id: string }; profile: unknown };
	expect(body.user.id).toBe("user-1");
	expect(body.profile).toBeNull();
});

test("profile-scoped routes still require an active profile", async () => {
	stubs.push(stubSignedInSession("user-1"));

	const response = await app.handle(new Request("http://localhost/me/continue-watching", { headers: { authorization: "Bearer test" } }));

	expect(response.status).toBe(401);
	expect(await response.json()).toMatchObject({ code: "auth.profile_required" });
});

test("stream preferences are refused for a media file the stream-access policy denies", async () => {
	stubs.push(stubSignedInSession("user-1"));
	unregisterPolicies.push(
		pluginAccessBus.register("test-plugin", {
			id: "region-block",
			beforeAccess: () => ({ allowed: false, code: "stream.region_blocked", message: "Not available in your region" }),
		}),
	);

	const response = await app.handle(
		new Request("http://localhost/me/stream-prefs/media-file-1", {
			headers: { authorization: "Bearer test", "x-profile-id": "profile-1" },
		}),
	);

	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: "stream.region_blocked" });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/app/http/middleware/domain-errors.middleware";
import { profilesRepository } from "@/app/repositories/profiles.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { hashProfilePin } from "@/utils/crypto.utils";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";

const [{ profilesRoutes }, { auth }] = await Promise.all([
	import("./profiles.routes"),
	import("@/integrations/better-auth/better-auth.config"),
]);
const app = new Elysia().use(domainErrorsMiddleware).use(profilesRoutes);
const { client } = useTestDatabase();

const PROFILE_IDS = ["profile-1", "profile-2", "profile-3"];
const originalGetSession = auth.api.getSession;

beforeEach(async () => {
	// The auth hot path caches profile rows process-wide, so a fresh per-test database must not read a copy another test left behind.
	for (const id of PROFILE_IDS) profilesRepository.invalidateCached(id);
	await client().insert(schema.users).values({ id: "user-1", name: "User", email: "user@example.com", emailVerified: true });
	await client()
		.insert(schema.profiles)
		.values([
			{ id: "profile-1", userId: "user-1", name: "Ada" },
			{ id: "profile-2", userId: "user-1", name: "Bob" },
		]);
});

afterEach(() => {
	auth.api.getSession = originalGetSession;
	for (const id of PROFILE_IDS) profilesRepository.invalidateCached(id);
});

/** Wraps a fake better-auth session payload so the mock matches auth.api.getSession's shape. */
function fakeGetSession(body: unknown): typeof auth.api.getSession {
	return (async () => body) as typeof auth.api.getSession;
}

/** Signed in as user-1; the profile rows are real and seeded in beforeEach. */
function signInAsUser1(): void {
	const now = new Date("2026-01-02T03:04:05.000Z");
	auth.api.getSession = fakeGetSession({
		user: {
			id: "user-1",
			name: "User",
			email: "user@example.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
			role: "user",
			banned: false,
		},
		session: { id: "session-1" },
	});
}

test("profile preferences endpoint rejects unauthenticated requests", async () => {
	const response = await app.handle(new Request("http://localhost/profiles/profile-1/preferences"));

	expect(response.status).toBe(401);
});

test("profile preferences store an update and read it back for an authorized profile", async () => {
	signInAsUser1();

	const patch = await app.handle(
		new Request("http://localhost/profiles/profile-1/preferences", {
			method: "PATCH",
			headers: { "content-type": "application/json", authorization: "Bearer test" },
			body: JSON.stringify({ theme: "dark", autoplay: true, audioLanguage: "pl" }),
		}),
	);

	expect(patch.status).toBe(200);
	expect(await patch.json()).toMatchObject({ profileId: "profile-1", theme: "dark", autoplay: true, audioLanguage: "pl" });

	const get = await app.handle(
		new Request("http://localhost/profiles/profile-1/preferences", { headers: { authorization: "Bearer test" } }),
	);

	expect(get.status).toBe(200);
	expect(await get.json()).toMatchObject({ profileId: "profile-1", theme: "dark", audioLanguage: "pl" });
});

test("profile switch returns the unlock token in the body only for native shells", async () => {
	signInAsUser1();
	await client()
		.insert(schema.profiles)
		.values({ id: "profile-3", userId: "user-1", name: "Cy", pin: (await hashProfilePin("1234")) ?? null });

	const native = await app.handle(
		new Request("http://localhost/profiles/switch", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test", "x-client-shell": "native" },
			body: JSON.stringify({ profileId: "profile-3", pin: "1234" }),
		}),
	);
	const nativeBody = (await native.json()) as { success: boolean; unlockToken?: string };

	expect(native.status).toBe(200);
	expect(nativeBody.unlockToken).toEqual(expect.any(String));
	expect(native.headers.getSetCookie().join("\n")).toContain(`profile_unlock=${nativeBody.unlockToken}`);

	const browser = await app.handle(
		new Request("http://localhost/profiles/switch", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test" },
			body: JSON.stringify({ profileId: "profile-3", pin: "1234" }),
		}),
	);

	expect(browser.status).toBe(200);
	expect(await browser.json()).toEqual({ success: true });
	expect(browser.headers.getSetCookie().join("\n")).toContain("profile_unlock=");
});

const REMOVED_PROFILE_COOKIE = /current_profile_id=;.*(Max-Age=0|Expires=)/i;

async function deleteProfile(profileId: string): Promise<Response> {
	return await app.handle(
		new Request(`http://localhost/profiles/${profileId}`, {
			method: "DELETE",
			headers: { authorization: "Bearer test", cookie: "current_profile_id=profile-1; profile_unlock=proof" },
		}),
	);
}

test("deleting the active profile clears its profile cookies, while deleting another profile leaves them", async () => {
	signInAsUser1();

	const other = await deleteProfile("profile-2");

	expect(other.status).toBe(200);
	expect(other.headers.getSetCookie().join("\n")).not.toContain("current_profile_id=");

	const active = await deleteProfile("profile-1");

	expect(active.status).toBe(200);
	const cleared = active.headers.getSetCookie().join("\n");
	expect(cleared).toContain("current_profile_id=");
	expect(cleared).toMatch(REMOVED_PROFILE_COOKIE);
	expect(await client().select().from(schema.profiles).all()).toEqual([]);
});

import { afterEach, expect, spyOn, test } from "bun:test";
import type { Profile } from "@sdk/common/profile.types";
import { Elysia } from "elysia";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";

function createMockProfile(overrides: Partial<Profile> = {}): Profile {
	return {
		id: "profile-1",
		userId: "user-1",
		name: "Default",
		avatarUrl: null,
		pin: null,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		...overrides,
	};
}

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";

const [{ authMiddleware }, { auth }, { invalidateSessionCache }] = await Promise.all([
	import("./auth.middleware"),
	import("@/integrations/better-auth/better-auth.config"),
	import("@/integrations/better-auth/better-auth.session-cache"),
]);

const originalGetSession = auth.api.getSession;
const originalFindCached = profilesRepository.findByPrimaryIdCached;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	profilesRepository.findByPrimaryIdCached = originalFindCached;
	invalidateSessionCache();
});

const SESSION_USER = {
	id: "user-1",
	name: "User",
	email: "user@example.com",
	emailVerified: true,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	role: "user",
	banned: false,
};

function mockSession(user = SESSION_USER): void {
	auth.api.getSession = (async () => ({ user, session: { id: "session-1" } })) as typeof auth.api.getSession;
}

function probeApp() {
	return new Elysia()
		.use(domainErrorsMiddleware)
		.use(authMiddleware)
		.get("/probe", ({ user, session, profile }) => ({
			userId: user?.id ?? null,
			role: user?.role ?? null,
			hasSession: session !== null,
			profileId: profile?.id ?? null,
		}))
		.get("/guarded", () => ({ ok: true }), { auth: true })
		.get("/admin", () => ({ ok: true }), { adminOnly: true })
		.get("/profiled", () => ({ ok: true }), { profileRequired: true })
		.get("/v1/images/*", () => ({ ok: true }))
		.post("/v1/images/*", () => ({ ok: true }))
		.get("/v1/plugins/ui/:pluginId/*", () => ({ ok: true }))
		.get("/v1/plugins/ui/manifest", () => ({ ok: true }), { auth: true });
}

test("requests without auth credentials skip session verification entirely", async () => {
	let getSessionCalled = false;
	auth.api.getSession = (() => {
		getSessionCalled = true;

		return Promise.resolve(null);
	}) as typeof auth.api.getSession;

	const response = await probeApp().handle(new Request("http://localhost/probe", { headers: { cookie: "other_cookie=x" } }));

	expect(await response.json()).toEqual({ userId: null, role: null, hasSession: false, profileId: null });
	expect(getSessionCalled).toBe(false);
});

test("authorization header and session cookies both count as credentials", async () => {
	mockSession();
	const repoSpy = spyOnFindCached(null);

	const bearer = await probeApp().handle(new Request("http://localhost/probe", { headers: { authorization: "Bearer x" } }));
	expect((await bearer.json()).userId).toBe("user-1");

	for (const cookie of [
		"session_token=abc",
		"__Secure-better-auth.session_token=abc",
		"__Host-better-auth.session_token=abc",
		"better-auth.session_token=abc",
	]) {
		const response = await probeApp().handle(new Request("http://localhost/probe", { headers: { cookie } }));
		expect((await response.json()).userId).toBe("user-1");
	}

	repoSpy.mockRestore();
});

test("public GET image requests skip session verification even with credentials", async () => {
	let getSessionCalled = false;
	auth.api.getSession = (() => {
		getSessionCalled = true;

		return Promise.resolve({ user: SESSION_USER, session: { id: "session-1" } });
	}) as typeof auth.api.getSession;

	const response = await probeApp().handle(
		new Request("http://localhost/v1/images/cache/poster.webp", { headers: { cookie: "session_token=abc" } }),
	);

	expect(response.status).toBe(200);
	expect(getSessionCalled).toBe(false);

	// Non-GET requests to the same prefix still go through verification.
	const post = await probeApp().handle(
		new Request("http://localhost/v1/images/cache/poster.webp", { method: "POST", headers: { cookie: "session_token=abc" } }),
	);
	expect(post.status).toBe(200);
	expect(getSessionCalled).toBe(true);
});

test("plugin UI assets are public while the UI manifest stays guarded", async () => {
	let getSessionCalled = false;
	auth.api.getSession = (() => {
		getSessionCalled = true;

		return Promise.resolve(null);
	}) as typeof auth.api.getSession;

	// Cross-origin ESM import carries no credentials — the asset must load anyway.
	const asset = await probeApp().handle(new Request("http://localhost/v1/plugins/ui/org.example.x/dist/ui/index.js"));
	expect(asset.status).toBe(200);
	expect(getSessionCalled).toBe(false);

	// The manifest is role-filtered, so it must reject anonymous requests.
	const manifest = await probeApp().handle(new Request("http://localhost/v1/plugins/ui/manifest"));
	expect(manifest.status).toBe(401);
});

test("an expired session yields an anonymous context", async () => {
	auth.api.getSession = (async () => null) as typeof auth.api.getSession;
	repoSpyNoop();

	const response = await probeApp().handle(new Request("http://localhost/probe", { headers: { cookie: "session_token=abc" } }));
	expect((await response.json()).userId).toBe(null);
});

test("profile is only exposed when it belongs to the authenticated user", async () => {
	mockSession();
	const foreignSpy = spyOnFindCached(createMockProfile({ id: "profile-2", userId: "user-2" }));
	const foreign = await probeApp().handle(
		new Request("http://localhost/probe", { headers: { cookie: "session_token=abc", "x-profile-id": "profile-2" } }),
	);
	expect((await foreign.json()).profileId).toBe(null);
	foreignSpy.mockRestore();

	const ownSpy = spyOnFindCached(createMockProfile({ id: "profile-1", userId: "user-1" }));
	const own = await probeApp().handle(
		new Request("http://localhost/probe", { headers: { cookie: "session_token=abc", "x-profile-id": "profile-1" } }),
	);
	expect((await own.json()).profileId).toBe("profile-1");
	ownSpy.mockRestore();
});

test("profile from the current_profile_id cookie is trusted the same way", async () => {
	mockSession();
	const spy = spyOnFindCached(createMockProfile({ id: "profile-1", userId: "user-1" }));

	const response = await probeApp().handle(
		new Request("http://localhost/probe", { headers: { cookie: "session_token=abc; current_profile_id=profile-1" } }),
	);

	expect((await response.json()).profileId).toBe("profile-1");
	spy.mockRestore();
});

test("auth macro rejects anonymous users with 401", async () => {
	const response = await probeApp().handle(new Request("http://localhost/guarded"));
	expect(response.status).toBe(401);
	expect(await response.json()).toMatchObject({ code: "auth.session_invalid" });
});

test("adminOnly macro rejects non-admin users with 403", async () => {
	mockSession(); // role: "user"
	const response = await probeApp().handle(new Request("http://localhost/admin", { headers: { cookie: "session_token=abc" } }));
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: "auth.admin_required" });
});

test("adminOnly macro admits admins and auth macro admits signed-in users", async () => {
	mockSession({ ...SESSION_USER, role: "admin" });
	const admin = await probeApp().handle(new Request("http://localhost/admin", { headers: { cookie: "session_token=abc" } }));
	expect(await admin.json()).toEqual({ ok: true });

	const guarded = await probeApp().handle(new Request("http://localhost/guarded", { headers: { cookie: "session_token=abc" } }));
	expect(await guarded.json()).toEqual({ ok: true });
});

test("profileRequired macro rejects signed-in users without an active profile", async () => {
	mockSession();
	repoSpyNoop();

	const response = await probeApp().handle(new Request("http://localhost/profiled", { headers: { cookie: "session_token=abc" } }));
	expect(response.status).toBe(401);
	expect(await response.json()).toMatchObject({ code: "auth.profile_required" });
});

function spyOnFindCached(value: Profile | null | undefined) {
	return spyOn(profilesRepository, "findByPrimaryIdCached").mockResolvedValue(value ?? undefined);
}

function repoSpyNoop(): void {
	spyOnFindCached(null);
}

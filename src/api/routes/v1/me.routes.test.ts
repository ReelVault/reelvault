import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";

const [{ meRoutes }, { auth }] = await Promise.all([import("./me.routes"), import("@/integrations/better-auth/better-auth.config")]);
const app = new Elysia().use(domainErrorsMiddleware).use(meRoutes);

const originalGetSession = auth.api.getSession;

afterEach(() => {
	auth.api.getSession = originalGetSession;
});

/** Wraps a fake better-auth session payload so the mock matches auth.api.getSession's shape. */
function fakeGetSession(body: unknown): typeof auth.api.getSession {
	return (async () => body) as typeof auth.api.getSession;
}

/** Signed-in session with no profile cookie — what the picker sends. */
function mockSignedInWithoutProfile(): void {
	const now = new Date("2026-01-02T03:04:05.000Z");
	auth.api.getSession = fakeGetSession({
		user: {
			id: "user-1",
			name: "User",
			email: "user@example.com",
			emailVerified: true,
			image: null,
			createdAt: now,
			updatedAt: now,
			role: "user",
			twoFactorEnabled: false,
			banned: false,
		},
		session: { id: "session-1", userId: "user-1", expiresAt: new Date("2099-01-02T03:04:05.000Z"), createdAt: now, updatedAt: now },
	});
}

test("GET /me answers before a profile is selected", async () => {
	mockSignedInWithoutProfile();

	const response = await app.handle(new Request("http://localhost/me/", { headers: { authorization: "Bearer test" } }));

	expect(response.status).toBe(200);
	const body = (await response.json()) as { user: { id: string }; profile: unknown };
	expect(body.user.id).toBe("user-1");
	expect(body.profile).toBeNull();
});

test("profile-scoped routes still require an active profile", async () => {
	mockSignedInWithoutProfile();

	const response = await app.handle(new Request("http://localhost/me/continue-watching", { headers: { authorization: "Bearer test" } }));

	expect(response.status).toBe(401);
	expect(await response.json()).toMatchObject({ code: "auth.profile_required" });
});

import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";
const [{ profilesRoutes }, { auth }, { profilesService }] = await Promise.all([
	import("./profiles.routes"),
	import("@/integrations/better-auth/better-auth.config"),
	import("@/application/users/profiles.service"),
]);
const app = new Elysia().use(domainErrorsMiddleware).use(profilesRoutes);

const originalGetSession = auth.api.getSession;
const originalUserHasPermission = auth.api.userHasPermission;
const originalGetPreferences = profilesService.getPreferences;
const originalUpdatePreferences = profilesService.updatePreferences;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	auth.api.userHasPermission = originalUserHasPermission;
	profilesService.getPreferences = originalGetPreferences;
	profilesService.updatePreferences = originalUpdatePreferences;
});

/** Wraps a fake better-auth session payload so the mock matches auth.api.getSession's shape. */
function fakeGetSession(body: unknown): typeof auth.api.getSession {
	return (async () => body) as typeof auth.api.getSession;
}

test("profile preferences endpoint rejects unauthenticated requests", async () => {
	const response = await app.handle(new Request("http://localhost/profiles/profile-1/preferences"));

	expect(response.status).toBe(401);
});

test("profile preferences endpoints read and update an authorized profile", async () => {
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
	auth.api.userHasPermission = (async () => ({ success: true })) as typeof auth.api.userHasPermission;
	profilesService.getPreferences = async () => ({
		id: "preferences-1",
		profileId: "profile-1",
		language: "en",
		theme: "system",
		autoplay: false,
		autoSkipIntro: false,
		autoSkipCredits: false,
		autoSkipRecap: false,
		audioLanguage: null,
		subtitleLanguage: "pl",
		subtitlesEnabled: true,
		forcedSubtitlesOnly: false,
		autoForcedSubtitles: false,
		preferHearingImpaired: false,
		continueWatchingMinutes: 2,
		subtitleSize: "normal",
		subtitlePosition: "bottom",
		subtitleColor: "white",
		subtitleBackground: "semi",
		createdAt: now,
		updatedAt: now,
	});
	profilesService.updatePreferences = async () => ({
		id: "preferences-1",
		profileId: "profile-1",
		language: "pl",
		theme: "dark",
		autoplay: true,
		autoSkipIntro: true,
		autoSkipCredits: true,
		autoSkipRecap: false,
		audioLanguage: "pl",
		subtitleLanguage: "pl",
		subtitlesEnabled: true,
		forcedSubtitlesOnly: false,
		autoForcedSubtitles: false,
		preferHearingImpaired: false,
		continueWatchingMinutes: 2,
		subtitleSize: "large",
		subtitlePosition: "bottom",
		subtitleColor: "yellow",
		subtitleBackground: "solid",
		createdAt: now,
		updatedAt: now,
	});

	const getResponse = await app.handle(
		new Request("http://localhost/profiles/profile-1/preferences", { headers: { authorization: "Bearer test" } }),
	);
	const patchResponse = await app.handle(
		new Request("http://localhost/profiles/profile-1/preferences", {
			method: "PATCH",
			headers: { "content-type": "application/json", authorization: "Bearer test" },
			body: JSON.stringify({ theme: "dark", autoplay: true, audioLanguage: "pl" }),
		}),
	);

	expect(getResponse.status).toBe(200);
	expect((await getResponse.json()).profileId).toBe("profile-1");
	expect(patchResponse.status).toBe(200);
	expect((await patchResponse.json()).theme).toBe("dark");
});

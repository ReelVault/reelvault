import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { profilesRepository } from "@/database/repositories/profiles.repository";
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
const originalSwitch = profilesService.switch;
const originalDelete = profilesService.delete;
const originalFindCached = profilesRepository.findByPrimaryIdCached;

afterEach(() => {
	auth.api.getSession = originalGetSession;
	auth.api.userHasPermission = originalUserHasPermission;
	profilesService.getPreferences = originalGetPreferences;
	profilesService.updatePreferences = originalUpdatePreferences;
	profilesService.switch = originalSwitch;
	profilesService.delete = originalDelete;
	profilesRepository.findByPrimaryIdCached = originalFindCached;
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
		subtitleFallbackLanguages: null,
		subtitlesEnabled: true,
		forcedSubtitlesOnly: false,
		autoForcedSubtitles: false,
		preferHearingImpaired: false,
		continueWatchingMinutes: 2,
		resumeRewindSeconds: 0,
		watchlistAutoRemoveWatched: false,
		hideRatingOverlay: false,
		mutedNotificationTypes: "",
		hiddenPages: "",
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
		subtitleFallbackLanguages: null,
		subtitlesEnabled: true,
		forcedSubtitlesOnly: false,
		autoForcedSubtitles: false,
		preferHearingImpaired: false,
		continueWatchingMinutes: 2,
		resumeRewindSeconds: 0,
		watchlistAutoRemoveWatched: false,
		hideRatingOverlay: false,
		mutedNotificationTypes: "",
		hiddenPages: "",
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

test("profile switch returns unlock token for native shells", async () => {
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
	profilesService.switch = async () => ({ success: true, profileId: "profile-1", unlockToken: "unlock-token-1" });

	const response = await app.handle(
		new Request("http://localhost/profiles/switch", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test", "x-client-shell": "native" },
			body: JSON.stringify({ profileId: "profile-1" }),
		}),
	);

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ success: true, unlockToken: "unlock-token-1" });
});

test("profile switch omits unlock token for browser clients", async () => {
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
	profilesService.switch = async () => ({ success: true, profileId: "profile-1", unlockToken: "unlock-token-1" });

	const response = await app.handle(
		new Request("http://localhost/profiles/switch", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer test" },
			body: JSON.stringify({ profileId: "profile-1" }),
		}),
	);

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ success: true });
});

const REMOVED_PROFILE_COOKIE = /current_profile_id=;.*(Max-Age=0|Expires=)/i;

function signInAs(userId: string): void {
	const now = new Date("2026-01-02T03:04:05.000Z");
	auth.api.getSession = fakeGetSession({
		user: {
			id: userId,
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
}

function stubActiveProfile(profileId: string): void {
	profilesRepository.findByPrimaryIdCached = (async () => ({
		id: profileId,
		userId: "user-1",
		name: "P",
		pin: null,
	})) as unknown as typeof profilesRepository.findByPrimaryIdCached;
}

async function deleteProfile(profileId: string): Promise<Response> {
	return await app.handle(
		new Request(`http://localhost/profiles/${profileId}`, {
			method: "DELETE",
			headers: { authorization: "Bearer test", cookie: "current_profile_id=profile-1; profile_unlock=proof" },
		}),
	);
}

test("deleting the profile the client is acting as clears its profile cookies", async () => {
	signInAs("user-1");
	stubActiveProfile("profile-1");
	profilesService.delete = async () => ({ success: true });

	const response = await deleteProfile("profile-1");

	expect(response.status).toBe(200);
	const cleared = response.headers.getSetCookie().join("\n");
	expect(cleared).toContain("current_profile_id=");
	expect(cleared).toMatch(REMOVED_PROFILE_COOKIE);
});

test("deleting a different profile keeps the active profile cookies", async () => {
	signInAs("user-1");
	stubActiveProfile("profile-1");
	profilesService.delete = async () => ({ success: true });

	const response = await deleteProfile("profile-2");

	expect(response.status).toBe(200);
	expect(response.headers.getSetCookie().join("\n")).not.toContain("current_profile_id=");
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { notificationsService } from "@/app/notifications/notifications.service";
import { profilesRepository } from "@/app/repositories/profiles.repository";
import { twoFactorRepository } from "@/app/repositories/two-factor.repository";
import { env } from "@/config/env.config";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { twoFactors, users } from "@/integrations/drizzle-orm/schemas/auth.schema";
import { libraries } from "@/integrations/drizzle-orm/schemas/libraries.schema";
import { mediaFiles } from "@/integrations/drizzle-orm/schemas/media-files.schema";
import { metadata } from "@/integrations/drizzle-orm/schemas/metadata.schema";
import { movies } from "@/integrations/drizzle-orm/schemas/movies.schema";
import { notifications } from "@/integrations/drizzle-orm/schemas/notifications.schema";
import { profiles } from "@/integrations/drizzle-orm/schemas/profiles.schema";
import { watchedHistory } from "@/integrations/drizzle-orm/schemas/watched-history.schema";
import { watchlist } from "@/integrations/drizzle-orm/schemas/watchlist.schema";
import { PROFILE_UNLOCK_COOKIE, profilePinFingerprint, signProfileUnlock } from "@/utils/profile-unlock.utils";
import { installSessionStub, prepareSecuritySuite, send } from "./security.helper";

/**
 * Two ordinary accounts, each with its own profiles, and the rows those profiles own:
 * notifications, watchlist entries, watch history and a second-factor record. A request
 * runs as one account with one active profile. A profile of another account, or of
 * another profile on the same account, must never be read, changed or removed, and a
 * PIN-protected profile opens only with a token signed for its current PIN.
 */

prepareSecuritySuite();

const sessionStub = installSessionStub();
afterAll(() => sessionStub.restore());

const client = databaseFactory.getClient();

const USER_ID = "security-user";
const OTHER_ID = "security-other";

const PROFILE = {
	mine: "iso-profile-mine",
	second: "iso-profile-second",
	pinned: "iso-profile-pinned",
	foreign: "iso-profile-foreign",
} as const;

const PINNED_PIN = "iso-stored-pin";
const LIBRARY_ID = "iso-library";
const METADATA_ID = "iso-metadata";
const MOVIE_ID = "iso-movie";
const MEDIA_FILE_ID = "iso-media-file";

// Routes that refuse a request without an active profile. Notifications answer without one, with account-wide rows only.
const PROFILE_REQUIRED_ROUTES = ["/v1/me/watchlist", "/v1/me/watched-history", "/v1/me/ratings", "/v1/me/continue-watching"];

const UNLOCK_ATTEMPTS: Record<string, string> = {
	"a forged token": "not-a-real-token",
	"a token for another profile": signProfileUnlock(PROFILE.mine, env.BETTER_AUTH_SECRET, profilePinFingerprint(PINNED_PIN)),
	"a token signed for an earlier PIN": signProfileUnlock(PROFILE.pinned, env.BETTER_AUTH_SECRET, profilePinFingerprint("previous-pin")),
	"a token signed with another secret": signProfileUnlock(PROFILE.pinned, "x".repeat(48), profilePinFingerprint(PINNED_PIN)),
};

async function seedAccounts(): Promise<void> {
	const now = new Date();
	await client
		.insert(users)
		.values(
			[USER_ID, OTHER_ID].map((id) => ({
				id,
				name: id,
				email: `${id}@example.test`,
				emailVerified: true,
				role: "user",
				banned: false,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.onConflictDoNothing();
	await client
		.insert(profiles)
		.values([
			{ id: PROFILE.mine, userId: USER_ID, name: "Isolation mine", createdAt: now, updatedAt: now },
			{ id: PROFILE.second, userId: USER_ID, name: "Isolation second", createdAt: now, updatedAt: now },
			{ id: PROFILE.pinned, userId: USER_ID, name: "Isolation pinned", pin: PINNED_PIN, createdAt: now, updatedAt: now },
			{ id: PROFILE.foreign, userId: OTHER_ID, name: "Isolation foreign", createdAt: now, updatedAt: now },
		])
		.onConflictDoNothing();
	await client
		.insert(libraries)
		.values({ id: LIBRARY_ID, name: "Isolation library", type: "movies", createdAt: now, updatedAt: now })
		.onConflictDoNothing();
	await client
		.insert(metadata)
		.values({
			id: METADATA_ID,
			stableKey: "iso-metadata",
			title: "Isolation movie",
			type: "movie",
			releaseDate: "2001-01-01",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	await client
		.insert(movies)
		.values({ id: MOVIE_ID, stableKey: "iso-movie", metadataId: METADATA_ID, createdAt: now, updatedAt: now })
		.onConflictDoNothing();
	await client
		.insert(mediaFiles)
		.values({
			id: MEDIA_FILE_ID,
			libraryId: LIBRARY_ID,
			metadataId: METADATA_ID,
			movieId: MOVIE_ID,
			filePath: "/iso/movie.mkv",
			fileName: "movie.mkv",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
}

beforeEach(async () => {
	await seedAccounts();
	// A test that changes the PIN must not leak the new value into the next one.
	await client.update(profiles).set({ pin: PINNED_PIN }).where(eq(profiles.id, PROFILE.pinned));
	profilesRepository.invalidateCached(PROFILE.pinned);
	await client.delete(watchlist);
	await client.delete(watchedHistory);
	await client.delete(notifications);
});

async function notifyProfile(userId: string, profileId: string): Promise<string> {
	return await notificationsService.create({ userId, profileId, type: "isolation.test", title: "Isolation notification" });
}

async function listNotificationIds(profileId: string): Promise<string[]> {
	const response = await send("GET", "/v1/notifications", { role: "user", headers: { "x-profile-id": profileId } });
	const body = (await response.json()) as Array<{ id: string }>;

	return body.map((item) => item.id);
}

async function insertHistory(profileId: string): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date();
	await client.insert(watchedHistory).values({
		id,
		mediaFileId: MEDIA_FILE_ID,
		profileId,
		durationWatched: 120,
		isFullWatch: false,
		watchedAt: now,
		createdAt: now,
		updatedAt: now,
	});

	return id;
}

describe("profile ownership", () => {
	test("a profile of another account is never the active profile on profile-required routes", async () => {
		const refusals: Array<{ path: string; status: number; code: unknown }> = [];
		for (const path of PROFILE_REQUIRED_ROUTES) {
			const response = await send("GET", path, { role: "user", headers: { "x-profile-id": PROFILE.foreign } });
			const body = (await response.json()) as { code?: unknown };
			refusals.push({ path, status: response.status, code: body.code });
		}

		expect(refusals).toEqual(PROFILE_REQUIRED_ROUTES.map((path) => ({ path, status: 401, code: "auth.profile_required" })));
	});

	test("a foreign profile cannot add to a watchlist", async () => {
		const response = await send("POST", "/v1/me/watchlist", {
			role: "user",
			headers: { "x-profile-id": PROFILE.foreign },
			body: { metadataId: METADATA_ID },
		});
		const rows = await client.select().from(watchlist).where(eq(watchlist.profileId, PROFILE.foreign));

		expect(response.status).toBe(401);
		expect(rows).toHaveLength(0);
	});

	test("another account's profile cannot be read, renamed or deleted", async () => {
		const read = await send("GET", `/v1/profiles/${PROFILE.foreign}`, { role: "user" });
		const renamed = await send("PATCH", `/v1/profiles/${PROFILE.foreign}`, { role: "user", body: { name: "hijacked" } });
		const removed = await send("DELETE", `/v1/profiles/${PROFILE.foreign}`, { role: "user" });
		const [row] = await client.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, PROFILE.foreign));

		expect([read.status, renamed.status, removed.status]).toEqual([403, 403, 403]);
		expect(await read.text()).not.toContain("Isolation foreign");
		expect(row?.name).toBe("Isolation foreign");
	});
});

describe("PIN-protected profiles", () => {
	test("a PIN-protected profile stays locked without an unlock token", async () => {
		const response = await send("GET", "/v1/me/watchlist", { role: "user", headers: { "x-profile-id": PROFILE.pinned } });

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "auth.profile_required" });
	});

	test("unlock tokens that are forged, bound to another profile, or signed for an old PIN do not open it", async () => {
		const results: Array<{ attempt: string; status: number }> = [];
		for (const [attempt, token] of Object.entries(UNLOCK_ATTEMPTS)) {
			const response = await send("GET", "/v1/me/watchlist", {
				headers: {
					cookie: `better-auth.session_token=user-token; ${PROFILE_UNLOCK_COOKIE}=${token}`,
					"x-profile-id": PROFILE.pinned,
				},
			});
			results.push({ attempt, status: response.status });
		}

		expect(results).toEqual(Object.keys(UNLOCK_ATTEMPTS).map((attempt) => ({ attempt, status: 401 })));
	});

	test("a cached private body is not served after the PIN changes", async () => {
		await client.insert(watchlist).values({ profileId: PROFILE.pinned, metadataId: METADATA_ID });
		const token = signProfileUnlock(PROFILE.pinned, env.BETTER_AUTH_SECRET, profilePinFingerprint(PINNED_PIN));
		const headers = {
			cookie: `better-auth.session_token=user-token; ${PROFILE_UNLOCK_COOKIE}=${token}`,
			"x-profile-id": PROFILE.pinned,
		};

		const unlocked = await send("GET", "/v1/me/watchlist", { headers });
		expect(unlocked.status).toBe(200);

		await client.update(profiles).set({ pin: "a-new-pin" }).where(eq(profiles.id, PROFILE.pinned));
		profilesRepository.invalidateCached(PROFILE.pinned);

		const locked = await send("GET", "/v1/me/watchlist", { headers });
		expect(locked.status).toBe(401);
	});

	test("a token signed for the current PIN opens the profile", async () => {
		const token = signProfileUnlock(PROFILE.pinned, env.BETTER_AUTH_SECRET, profilePinFingerprint(PINNED_PIN));
		const response = await send("GET", "/v1/me/watchlist", {
			headers: {
				cookie: `better-auth.session_token=user-token; ${PROFILE_UNLOCK_COOKIE}=${token}`,
				"x-profile-id": PROFILE.pinned,
			},
		});

		expect(response.status).toBe(200);
	});
});

describe("notifications", () => {
	test("another account's notifications never appear in the caller's list", async () => {
		const foreignId = await notifyProfile(OTHER_ID, PROFILE.foreign);
		const ownId = await notifyProfile(USER_ID, PROFILE.mine);

		const ids = await listNotificationIds(PROFILE.mine);

		expect(ids).toContain(ownId);
		expect(ids).not.toContain(foreignId);
	});

	test("a foreign profile header falls back to account-wide notifications only", async () => {
		const foreignId = await notifyProfile(OTHER_ID, PROFILE.foreign);
		const ownId = await notifyProfile(USER_ID, PROFILE.mine);

		const ids = await listNotificationIds(PROFILE.foreign);

		expect(ids).not.toContain(foreignId);
		expect(ids).not.toContain(ownId);
	});

	test("notifications of a PIN-protected profile are visible only after a valid unlock", async () => {
		const lockedId = await notifyProfile(USER_ID, PROFILE.pinned);
		const locked = await listNotificationIds(PROFILE.pinned);

		const token = signProfileUnlock(PROFILE.pinned, env.BETTER_AUTH_SECRET, profilePinFingerprint(PINNED_PIN));
		const unlocked = await send("GET", "/v1/notifications", {
			headers: {
				cookie: `better-auth.session_token=user-token; ${PROFILE_UNLOCK_COOKIE}=${token}`,
				"x-profile-id": PROFILE.pinned,
			},
		});
		const unlockedIds = ((await unlocked.json()) as Array<{ id: string }>).map((item) => item.id);

		expect(locked).not.toContain(lockedId);
		expect(unlockedIds).toContain(lockedId);
	});

	test("another profile's notifications on the same account stay hidden", async () => {
		const secondId = await notifyProfile(USER_ID, PROFILE.second);
		const ownId = await notifyProfile(USER_ID, PROFILE.mine);

		const ids = await listNotificationIds(PROFILE.mine);

		expect(ids).toContain(ownId);
		expect(ids).not.toContain(secondId);
	});

	test("another account's notification cannot be deleted, bulk-deleted or marked read", async () => {
		const foreignId = await notifyProfile(OTHER_ID, PROFILE.foreign);
		const headers = { "x-profile-id": PROFILE.mine };

		const removed = await send("DELETE", `/v1/notifications/${foreignId}`, { role: "user", headers });
		const bulk = await send("POST", "/v1/notifications/delete", { role: "user", headers, body: { ids: [foreignId] } });
		const marked = await send("PATCH", `/v1/notifications/${foreignId}`, { role: "user", headers, body: { read: true } });
		const [row] = await client.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, foreignId));

		expect(await removed.json()).toEqual({ deleted: 0 });
		expect(await bulk.json()).toEqual({ deleted: 0 });
		expect(marked.status).toBeGreaterThanOrEqual(400);
		expect(row?.readAt).toBeNull();
	});
});

describe("watchlist and watch history", () => {
	test("watchlist entries belong to one profile", async () => {
		await client.insert(watchlist).values({ profileId: PROFILE.mine, metadataId: METADATA_ID });

		const mine = await send("GET", "/v1/me/watchlist", { role: "user", headers: { "x-profile-id": PROFILE.mine } });
		const second = await send("GET", "/v1/me/watchlist", { role: "user", headers: { "x-profile-id": PROFILE.second } });

		expect(await mine.text()).toContain(METADATA_ID);
		expect(await second.text()).not.toContain(METADATA_ID);
	});

	test("watch history belongs to one profile", async () => {
		await insertHistory(PROFILE.mine);

		const mine = await send("GET", "/v1/me/watched-history", { role: "user", headers: { "x-profile-id": PROFILE.mine } });
		const second = await send("GET", "/v1/me/watched-history", { role: "user", headers: { "x-profile-id": PROFILE.second } });

		expect(await mine.text()).toContain(MEDIA_FILE_ID);
		expect(await second.text()).not.toContain(MEDIA_FILE_ID);
	});

	test("clearing watch history touches only the active profile", async () => {
		const rowId = await insertHistory(PROFILE.mine);

		await send("DELETE", "/v1/me/watched-history", { role: "user", headers: { "x-profile-id": PROFILE.second } });
		const rows = await client.select({ id: watchedHistory.id }).from(watchedHistory).where(eq(watchedHistory.id, rowId));

		expect(rows).toHaveLength(1);
	});
});

describe("second-factor records", () => {
	test("each account reads only its own backup codes", async () => {
		await client
			.insert(twoFactors)
			.values([
				{ id: "iso-2fa-user", userId: USER_ID, secret: "iso-secret-user", backupCodes: "codes-user" },
				{ id: "iso-2fa-other", userId: OTHER_ID, secret: "iso-secret-other", backupCodes: "codes-other" },
			])
			.onConflictDoNothing();

		expect(await twoFactorRepository.findEncryptedBackupCodes(USER_ID)).toBe("codes-user");
		expect(await twoFactorRepository.findEncryptedBackupCodes(OTHER_ID)).toBe("codes-other");
	});
});

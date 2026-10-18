import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { profilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { dispatchNotificationToChannels, registerNotificationChannel } from "@/plugins/runtime/notification-channel.registry";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body.cache";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import {
	insertMetadata,
	insertNotifications,
	insertProfiles,
	insertUsers,
	insertWatchlist,
	selectNotifications,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { notificationsService } from "./notifications.service";

const db = useTestDatabase();
const stubs: MethodStub[] = [];

beforeEach(async () => {
	await insertUsers(db.client(), [
		{ id: "user-1", name: "Viewer", email: "viewer@example.com", emailVerified: true },
		{ id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" },
		{ id: "admin-2", name: "Second admin", email: "second@example.com", emailVerified: true, role: "admin" },
	]);
	await insertProfiles(db.client(), { id: "profile-1", userId: "user-1", name: "Default" });
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

async function storedNotifications() {
	return await selectNotifications(db.client());
}

describe("notificationsService read-state flips", () => {
	test("markRead throws access_denied for a notification that is not the caller's", async () => {
		await insertNotifications(db.client(), { id: "n1", userId: "admin-1", type: "system", title: "Private", data: {} });

		await expect(notificationsService.markRead("n1", "user-1")).rejects.toMatchObject({ code: "notification.access_denied" });
	});
});

describe("notificationsService new episode batch", () => {
	test("flushes the cached notification list of every viewer the new episode is announced to", async () => {
		await insertMetadata(db.client(), {
			id: "meta-episode",
			stableKey: "meta-episode",
			title: "Show",
			type: "tv_show",
			releaseDate: "2020-01-01",
		});
		// A watchlist entry makes the profile a recipient without needing a media file.
		await insertWatchlist(db.client(), { profileId: "profile-1", metadataId: "meta-episode" });
		const key = responseCacheKey({ pathWithQuery: "/v1/notifications", cookie: "c", profileId: "profile-1", auth: "", apiKey: "" });
		setCachedResponseBody(key, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });
		expect(getCachedResponseBody(key)).toBeDefined();

		await notificationsService.notifyNewEpisode({ metadataId: "meta-episode", showTitle: "Show", seasonNumber: 1, episodeNumber: 2 });

		expect(getCachedResponseBody(key)).toBeUndefined();
		expect(await storedNotifications()).toEqual([
			expect.objectContaining({ userId: "user-1", profileId: "profile-1", type: "new_episode" }),
		]);
	});
});

describe("notificationsService.getPage", () => {
	test("leaves out the types the profile has muted", async () => {
		await profilePreferencesRepository.applyUpdate({
			profileId: "profile-1",
			body: { mutedNotificationTypes: "system, new_episode" },
		});
		await insertNotifications(db.client(), [
			{ id: "n-system", userId: "user-1", profileId: "profile-1", type: "system", title: "Muted", data: {} },
			{ id: "n-episode", userId: "user-1", profileId: "profile-1", type: "new_episode", title: "Muted too", data: {} },
			{ id: "n-report", userId: "user-1", profileId: "profile-1", type: "bug-report", title: "Visible", data: {} },
		]);

		const page = await notificationsService.getPage({}, "user-1", "profile-1");

		expect(page.data.map((notification) => notification.id)).toEqual(["n-report"]);
	});
});

describe("notificationsService.createForAdministrators", () => {
	test("creates one notification per administrator, attributed to the reporting plugin", async () => {
		await notificationsService.createForAdministrators(
			{ type: "bug-report", title: "Playback stutters" },
			{ sourcePluginId: "org.reelvault.bug-reports" },
		);

		const rows = await storedNotifications();
		expect(rows.map((row) => row.userId).toSorted()).toEqual(["admin-1", "admin-2"]);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "bug-report", title: "Playback stutters", sourcePluginId: "org.reelvault.bug-reports" }),
			]),
		);
	});

	test("a failing recipient does not stop the others and its error is rethrown", async () => {
		const quota = new Error("quota");
		const created: string[] = [];
		stubs.push(
			stubMethod(notificationsService, "create", (notification: { userId: string }) => {
				if (notification.userId === "admin-1") return Promise.reject(quota);
				created.push(notification.userId);

				return Promise.resolve("n");
			}),
		);

		await expect(notificationsService.createForAdministrators({ type: "bug-report", title: "Subtitles drift" })).rejects.toBe(quota);
		expect(created).toEqual(["admin-2"]);
	});
});

describe("notificationsService channel failure reports", () => {
	test("a failed administrator report is logged instead of escaping as an unhandled rejection", async () => {
		stubs.push(stubMethod(notificationsService, "createForAdministrators", () => Promise.reject(new Error("users unavailable"))));
		// The report runs detached: the logger call is the only observable outcome, so wait for it.
		const reported = new Promise<unknown[]>((resolve) => {
			stubs.push(
				stubMethod(notificationsService.logger, "warn", (...args: unknown[]) => {
					resolve(args);
				}),
			);
		});
		const unregister = registerNotificationChannel("plugin-report", {
			id: "report-channel",
			deliver: () => Promise.reject(new Error("503 from endpoint")),
		});

		try {
			await dispatchNotificationToChannels({ id: "n-1", userId: "u-1", type: "test", title: "Hello" });

			expect(await reported).toEqual([
				"Could not report a failing notification channel",
				expect.objectContaining({ channelId: "report-channel" }),
			]);
		} finally {
			unregister();
		}
	});
});

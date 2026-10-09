import { afterEach, describe, expect, test } from "bun:test";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { profilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body-cache";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { notificationsService } from "./notifications.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("notificationsService read-state flips", () => {
	test("updateStatus with read:false marks the ids unread", async () => {
		const unread = stubMethod(notificationsRepository, "markUnreadBatch", () => Promise.resolve());
		stubs.push(unread);
		const read = stubMethod(notificationsRepository, "markReadBatch", () => Promise.resolve());
		stubs.push(read);

		await notificationsService.updateStatus({ ids: ["n1", "n2"], read: false }, "u1");

		expect(unread.calls).toEqual([[["n1", "n2"], "u1", undefined]]);
		expect(read.calls.length).toBe(0);
	});

	test("updateStatus defaults to marking read", async () => {
		const unread = stubMethod(notificationsRepository, "markUnreadBatch", () => Promise.resolve());
		stubs.push(unread);
		const read = stubMethod(notificationsRepository, "markReadBatch", () => Promise.resolve());
		stubs.push(read);

		await notificationsService.updateStatus({ ids: ["n1"] }, "u1");

		expect(read.calls.length).toBe(1);
		expect(unread.calls.length).toBe(0);
	});

	test("updateStatus with all+read:false marks the whole inbox unread", async () => {
		const unreadAll = stubMethod(notificationsRepository, "markAllUnreadForRecipient", () => Promise.resolve());
		stubs.push(unreadAll);
		const readAll = stubMethod(notificationsRepository, "markAllReadForRecipient", () => Promise.resolve());
		stubs.push(readAll);

		await notificationsService.updateStatus({ all: true, read: false }, "u1", "p1");

		expect(unreadAll.calls).toEqual([["u1", "p1"]]);
		expect(readAll.calls.length).toBe(0);
	});

	test("markRead with read:false routes to the unread repository method", async () => {
		const unread = stubMethod(notificationsRepository, "markUnreadForRecipient", () => Promise.resolve(true));
		stubs.push(unread);

		await notificationsService.markRead("n1", "u1", undefined, false);

		expect(unread.calls).toEqual([["n1", "u1", undefined]]);
	});

	test("markRead throws access_denied only when no notification matched the recipient", async () => {
		stubs.push(stubMethod(notificationsRepository, "markReadForRecipient", () => Promise.resolve(false)));

		await expect(notificationsService.markRead("n1", "u1")).rejects.toMatchObject({ code: "notification.access_denied" });
	});

	test("markRead succeeds for a notification that is already in the requested state", async () => {
		// The repository reports a recipient match regardless of the previous state.
		stubs.push(stubMethod(notificationsRepository, "markReadForRecipient", () => Promise.resolve(true)));

		await expect(notificationsService.markRead("n1", "u1")).resolves.toEqual({ success: true });
	});
});

describe("notificationsService create", () => {
	test("flushes the recipient's cached notification list, not just the unread badge", async () => {
		stubs.push(stubMethod(notificationsRepository, "create", () => Promise.resolve("n1")));
		stubs.push(stubMethod(profilePreferencesRepository, "getEffective", () => Promise.resolve({ mutedNotificationTypes: "" })));
		const key = responseCacheKey({ pathWithQuery: "/v1/notifications", cookie: "c", profileId: "p1", auth: "", apiKey: "" });
		setCachedResponseBody(key, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });

		await notificationsService.create({ userId: "u1", profileId: "p1", type: "system", title: "Hello" }, { skipOwnershipCheck: true });

		expect(getCachedResponseBody(key)).toBeUndefined();
	});
});

describe("notificationsService.getPage", () => {
	test("pages the recipient's notifications with the filters and the total of the same filter", async () => {
		const page = stubMethod(notificationsRepository, "findPageForRecipient", () => Promise.resolve({ data: [], total: 42 }));
		stubs.push(stubMethod(profilePreferencesRepository, "getEffective", () => Promise.resolve({ mutedNotificationTypes: "" })));
		stubs.push(page);

		const result = await notificationsService.getPage(
			{ page: 3, limit: 10, unreadOnly: true, type: "subtitle_ready" },
			"user-1",
			"profile-1",
		);

		expect(page.calls).toEqual([
			[{ userId: "user-1", profileId: "profile-1", unreadOnly: true, type: "subtitle_ready", excludedTypes: [], limit: 10, offset: 20 }],
		]);
		expect(result).toMatchObject({ page: 3, limit: 10, total: 42, totalPages: 5, data: [] });
	});

	test("defaults to the first page of 25 unfiltered notifications", async () => {
		const page = stubMethod(notificationsRepository, "findPageForRecipient", () => Promise.resolve({ data: [], total: 0 }));
		stubs.push(page);

		await notificationsService.getPage({}, "user-1");

		expect(page.calls).toEqual([
			[{ userId: "user-1", profileId: undefined, unreadOnly: false, type: undefined, excludedTypes: [], limit: 25, offset: 0 }],
		]);
	});

	test("leaves out the types the profile has muted", async () => {
		stubs.push(
			stubMethod(profilePreferencesRepository, "getEffective", () => Promise.resolve({ mutedNotificationTypes: "system, new_episode" })),
		);
		const page = stubMethod(notificationsRepository, "findPageForRecipient", () => Promise.resolve({ data: [], total: 0 }));
		stubs.push(page);

		await notificationsService.getPage({}, "user-1", "profile-1");

		expect(page.calls).toEqual([
			[
				{
					userId: "user-1",
					profileId: "profile-1",
					unreadOnly: false,
					type: undefined,
					excludedTypes: ["system", "new_episode"],
					limit: 25,
					offset: 0,
				},
			],
		]);
	});
});

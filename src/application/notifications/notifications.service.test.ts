import { afterEach, describe, expect, test } from "bun:test";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
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

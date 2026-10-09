import { afterEach, describe, expect, test } from "bun:test";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { notificationsService } from "./notifications.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("NotificationsService.updateStatus mark-all scope", () => {
	test("marks only the given type as read when a type is sent", async () => {
		const markAll = stubMethod(notificationsRepository, "markAllReadForRecipient", () => Promise.resolve());
		stubs.push(markAll);

		expect(await notificationsService.updateStatus({ all: true, type: "new_episode" }, "user-1", "profile-1")).toEqual({ success: true });
		expect(markAll.calls).toEqual([["user-1", "profile-1", "new_episode"]]);
	});

	test("marks everything as read when no type is sent", async () => {
		const markAll = stubMethod(notificationsRepository, "markAllReadForRecipient", () => Promise.resolve());
		stubs.push(markAll);

		await notificationsService.updateStatus({ all: true }, "user-1", "profile-1");
		expect(markAll.calls).toEqual([["user-1", "profile-1", undefined]]);
	});

	test("the type scope also applies when marking unread", async () => {
		const markAllUnread = stubMethod(notificationsRepository, "markAllUnreadForRecipient", () => Promise.resolve());
		stubs.push(markAllUnread);

		await notificationsService.updateStatus({ all: true, read: false, type: "system" }, "user-1");
		expect(markAllUnread.calls).toEqual([["user-1", undefined, "system"]]);
	});
});

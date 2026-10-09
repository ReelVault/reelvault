import { afterEach, describe, expect, test } from "bun:test";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { notificationsService } from "./notifications.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("NotificationsService.deleteNotifications", () => {
	test("removes the listed notifications from the caller's own list and reports the count", async () => {
		const remove = stubMethod(notificationsRepository, "deleteBatchForRecipient", () => Promise.resolve(2));
		stubs.push(remove);

		expect(await notificationsService.deleteNotifications(["n-1", "n-2"], "user-1", "profile-1")).toEqual({ deleted: 2 });
		expect(remove.calls).toEqual([[["n-1", "n-2"], "user-1", "profile-1"]]);
	});
});

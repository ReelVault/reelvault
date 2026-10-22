import { describe, expect, test } from "bun:test";
import { insertNotifications, insertProfiles, insertUsers, selectNotifications } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { notificationsService } from "./notifications.service";

const db = useTestDatabase();

async function seedRecipients(): Promise<void> {
	const client = db.client();
	await insertUsers(client, [
		{ id: "user-1", name: "Viewer", email: "viewer@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
	await insertProfiles(client, { id: "profile-1", userId: "user-1", name: "Default" });
	await insertNotifications(client, [
		{ id: "n-1", userId: "user-1", profileId: "profile-1", type: "system", title: "One", data: {} },
		{ id: "n-2", userId: "user-1", profileId: "profile-1", type: "system", title: "Two", data: {} },
		{ id: "n-3", userId: "user-1", profileId: "profile-1", type: "system", title: "Three", data: {} },
		{ id: "n-other", userId: "user-2", profileId: null, type: "system", title: "Theirs", data: {} },
	]);
}

async function remainingIds(): Promise<string[]> {
	const rows = await selectNotifications(db.client());

	return rows.map((row) => row.id).toSorted();
}

describe("NotificationsService.deleteNotifications", () => {
	test("removes only the listed notifications from the caller's own list and reports the count", async () => {
		await seedRecipients();

		expect(await notificationsService.deleteNotifications(["n-1", "n-2"], "user-1", "profile-1")).toEqual({ deleted: 2 });
		expect(await remainingIds()).toEqual(["n-3", "n-other"]);
	});

	test("ignores ids that belong to another user and deletes nothing for them", async () => {
		await seedRecipients();

		expect(await notificationsService.deleteNotifications(["n-other"], "user-1", "profile-1")).toEqual({ deleted: 0 });
		expect(await remainingIds()).toEqual(["n-1", "n-2", "n-3", "n-other"]);
	});

	test("ignores ids that belong to another profile of the same user and deletes nothing for them", async () => {
		await seedRecipients();
		await insertProfiles(db.client(), { id: "profile-2", userId: "user-1", name: "Kids" });

		expect(await notificationsService.deleteNotifications(["n-1"], "user-1", "profile-2")).toEqual({ deleted: 0 });
		expect(await remainingIds()).toEqual(["n-1", "n-2", "n-3", "n-other"]);
	});
});

import { describe, expect, test } from "bun:test";
import { insertNotifications, insertProfiles, insertUsers, selectNotifications } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { notificationsService } from "./notifications.service";

const db = useTestDatabase();

async function seedNotifications(): Promise<void> {
	const client = db.client();
	await insertUsers(client, [
		{ id: "user-1", name: "Viewer", email: "viewer@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
	await insertProfiles(client, { id: "profile-1", userId: "user-1", name: "Default" });
	await insertNotifications(client, [
		{ id: "n-episode", userId: "user-1", profileId: "profile-1", type: "new_episode", title: "Episode", data: {} },
		{ id: "n-system", userId: "user-1", profileId: "profile-1", type: "system", title: "System", data: {} },
		{ id: "n-other", userId: "user-2", profileId: null, type: "new_episode", title: "Theirs", data: {} },
	]);
}

async function unreadIds(): Promise<string[]> {
	const rows = await selectNotifications(db.client());

	return rows
		.filter((row) => row.readAt === null)
		.map((row) => row.id)
		.toSorted();
}

describe("NotificationsService.updateStatus mark-all scope", () => {
	test("marks only the given type as read when a type is sent", async () => {
		await seedNotifications();

		expect(await notificationsService.updateStatus({ all: true, type: "new_episode" }, "user-1", "profile-1")).toEqual({ success: true });
		expect(await unreadIds()).toEqual(["n-other", "n-system"]);
	});
});

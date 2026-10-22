import { beforeEach, describe, expect, test } from "bun:test";
import { insertUsers, selectNotifications } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { waitFor } from "../../../tests/helpers/wait.helper";
import { adminFailureNotificationService } from "./admin-failure-notification.service";

const { client } = useTestDatabase();

beforeEach(async () => {
	await insertUsers(client(), [
		{ id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" },
		{ id: "admin-2", name: "Second admin", email: "second@example.com", emailVerified: true, role: "admin" },
		{ id: "viewer-1", name: "Viewer", email: "viewer@example.com", emailVerified: true, role: "user" },
	]);
});

describe("AdminFailureNotificationService", () => {
	// Each test uses its own worker id: the dedupe window is process-wide and must not carry a failure from another test.
	test("notifies every administrator about a failed worker and no one else", async () => {
		adminFailureNotificationService.notifyWorkerFailed(`worker-${crypto.randomUUID()}`, "boom");
		// The write is detached, so wait until both administrators have their row.
		await waitFor(async () => (await selectNotifications(client())).length === 2);

		const rows = await selectNotifications(client());

		expect(rows.map((row) => `${row.userId}|${row.type}|${row.title}|${row.link}`).toSorted()).toEqual([
			"admin-1|worker_failed|notification.worker_failed|/admin/workers",
			"admin-2|worker_failed|notification.worker_failed|/admin/workers",
		]);
	});

	test("does not repeat an identical failure inside the dedupe window", async () => {
		const workerId = `worker-${crypto.randomUUID()}`;
		adminFailureNotificationService.notifyWorkerFailed(workerId, "boom");
		adminFailureNotificationService.notifyWorkerFailed(workerId, "boom");
		await waitFor(async () => (await selectNotifications(client())).some((row) => row.userId === "admin-1"));
		// A repeat inside the window would be written after the first; one more flush gives it a chance to land.
		await Bun.sleep(0);

		const rows = await selectNotifications(client());

		expect(rows.filter((row) => row.userId === "admin-1")).toHaveLength(1);
	});
});

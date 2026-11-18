import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { notificationsService } from "@/services/notifications/notifications.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertUsers, selectNotifications } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminFailureNotificationService } from "./admin-failure-notification.service";

const { client } = useTestDatabase();

// The notification write is detached. Capture the real promises so the tests
// wait for the actual writes instead of a fixed sleep, then restore the seam.
const activeWrites: Array<Promise<number>> = [];
let writeStub: ReturnType<typeof stubMethod> | undefined;

afterEach(() => {
	writeStub?.restore();
	writeStub = undefined;
	activeWrites.length = 0;
});

async function flushDetachedWrites(): Promise<void> {
	await Promise.all(activeWrites.splice(0));
}

beforeEach(async () => {
	const createForAdministrators = notificationsService.createForAdministrators.bind(notificationsService);
	writeStub = stubMethod(notificationsService, "createForAdministrators", (notification, options) => {
		const write = createForAdministrators(notification, options);
		activeWrites.push(write);

		return write;
	});

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
		await flushDetachedWrites();

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
		await flushDetachedWrites();

		const rows = await selectNotifications(client());

		expect(rows.filter((row) => row.userId === "admin-1")).toHaveLength(1);
	});
});

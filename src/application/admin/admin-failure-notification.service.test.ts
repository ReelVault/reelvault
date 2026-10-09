import { afterEach, describe, expect, test } from "bun:test";
import { notificationsService } from "@/application/notifications/notifications.service";
import { usersRepository } from "@/database/repositories/users.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminFailureNotificationService } from "./admin-failure-notification.service";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

type AdminRow = Awaited<ReturnType<typeof usersRepository.findAllAdministrators>>[number];

const now = new Date();
const adminRow: AdminRow = {
	id: "admin-1",
	name: "Admin",
	email: "admin@example.com",
	emailVerified: true,
	image: null,
	role: "admin",
	banned: false,
	banReason: null,
	banExpires: null,
	twoFactorEnabled: false,
	createdAt: now,
	updatedAt: now,
};

function stubAdmins() {
	activeStubs.push(stubMethod(usersRepository, "findAllAdministrators", () => Promise.resolve([adminRow])));
}

describe("AdminFailureNotificationService", () => {
	test("notifies every administrator about a failed worker", async () => {
		stubAdmins();
		const created: Array<Record<string, unknown>> = [];
		activeStubs.push(
			stubMethod(notificationsService, "create", (notification: Record<string, unknown>) => {
				created.push(notification);

				return Promise.resolve("notification-1");
			}),
		);

		await adminFailureNotificationService.notifyWorkerFailed("library-scan", "boom");

		// The write is detached — one macrotask flushes the microtask chain.
		await Bun.sleep(0);

		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			userId: "admin-1",
			type: "worker_failed",
			title: "notification.worker_failed",
			link: "/admin/workers",
		});
	});

	test("does not repeat an identical failure inside the window", async () => {
		stubAdmins();
		let created = 0;
		activeStubs.push(
			stubMethod(notificationsService, "create", () => {
				created += 1;

				return Promise.resolve("notification-1");
			}),
		);

		await adminFailureNotificationService.notifyWorkerFailed("media-file-audit", "boom");
		await adminFailureNotificationService.notifyWorkerFailed("media-file-audit", "boom");
		await Bun.sleep(0);

		expect(created).toBe(1);
	});

	test("notifies about a distinct failure", async () => {
		stubAdmins();
		const titles: string[] = [];
		activeStubs.push(
			stubMethod(notificationsService, "create", (notification: { title: string }) => {
				titles.push(notification.title);

				return Promise.resolve("notification-1");
			}),
		);

		await adminFailureNotificationService.notifyUpdateFailed("server", "1.3.0");
		await adminFailureNotificationService.notifyResourceAlert("system.disk_low", { percent: 91 });
		await Bun.sleep(0);

		expect(titles).toContain("notification.update_failed");
		expect(titles).toContain("system.disk_low");
	});
});

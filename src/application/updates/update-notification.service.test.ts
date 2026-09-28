import { afterEach, describe, expect, test } from "bun:test";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { notificationsService } from "@/application/notifications/notifications.service";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { updateCheckService } from "./update-check.service";
import { updateNotificationService } from "./update-notification.service";

function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { restore(): void; calls: unknown[][] } {
	const calls: unknown[][] = [];
	const original = Reflect.get(target, method) as unknown;
	Reflect.set(target, method, (...args: never[]) => {
		calls.push([...args] as unknown[]);

		return impl(...args);
	});

	return {
		calls,
		restore: () => Reflect.set(target, method, original),
	};
}

function release(version: string): AdminUpdateRelease {
	return {
		version,
		name: `ReelVault ${version}`,
		url: "https://github.com/ReelVault/reelvault/releases/tag/v1.0.1",
		publishedAt: null,
		notes: null,
		minServerVersion: null,
		assets: [],
	};
}

const stubs: Array<{ restore(): void }> = [];

function stubCheckState(
	serverLatest: AdminUpdateRelease | null,
	webLatest: AdminUpdateRelease | null,
	serverAvailable: boolean,
	webAvailable: boolean,
): void {
	stubs.push(stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()));
	stubs.push(
		stubMethod(updateCheckService, "getState", () => ({
			serverLatest,
			webLatest,
			serverUpdateAvailable: serverAvailable,
			webUpdateAvailable: webAvailable,
			lastCheckedAt: null,
			serverLastError: null,
			webLastError: null,
		})),
	);
}

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("updateNotificationService.notifyIfUpdateAvailable", () => {
	test("notifies every administrator once per component release", async () => {
		stubCheckState(release("1.0.1"), release("0.2.0"), true, true);
		stubs.push(stubMethod(notificationsRepository, "existsForVersion", () => false));
		stubs.push(stubMethod(usersRepository, "selectMany", () => [{ id: "admin-1" }, { id: "admin-2" }]));
		const create = stubMethod(notificationsService, "create", () => Promise.resolve("n-1"));
		stubs.push(create);

		const notified = await updateNotificationService.notifyIfUpdateAvailable(true);

		expect(notified).toBe(true);
		expect(create.calls.length).toBe(4); // 2 components × 2 admins
		const serverPayload = create.calls[0]?.[0] as Record<string, unknown>;
		expect(serverPayload.type).toBe("update_available");
		expect(serverPayload.title).toBe("notification.update_available_server");
		expect((serverPayload.data as Record<string, unknown>).component).toBe("server");
		expect((serverPayload.data as Record<string, unknown>).version).toBe("1.0.1");
		const webPayload = create.calls[2]?.[0] as Record<string, unknown>;
		expect(webPayload.title).toBe("notification.update_available_web");
		expect((webPayload.data as Record<string, unknown>).component).toBe("web");
	});

	test("does not re-notify for an already-announced component release", async () => {
		stubCheckState(release("1.0.1"), null, true, false);
		stubs.push(stubMethod(notificationsRepository, "existsForVersion", () => true));
		const create = stubMethod(notificationsService, "create", () => Promise.resolve("n-1"));
		stubs.push(create);

		const notified = await updateNotificationService.notifyIfUpdateAvailable(true);

		expect(notified).toBe(false);
		expect(create.calls.length).toBe(0);
	});

	test("stays quiet when both components are up to date", async () => {
		stubCheckState(null, null, false, false);
		const create = stubMethod(notificationsService, "create", () => Promise.resolve("n-1"));
		stubs.push(create);

		const notified = await updateNotificationService.notifyIfUpdateAvailable(true);

		expect(notified).toBe(false);
		expect(create.calls.length).toBe(0);
	});
});

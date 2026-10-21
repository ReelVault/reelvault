import { afterEach, describe, expect, test } from "bun:test";
import type { AdminUpdateRelease } from "@reelvault/sdk/common";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertNotifications, insertUsers, selectNotifications } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { updateCheckService } from "./update-check.service";
import { updateNotificationService } from "./update-notification.service";

// Notifications and administrators live in the test database. Only the release check, which
// reaches the network, is stubbed; it reports the release state the test sets up.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

function release(version: string): AdminUpdateRelease {
	return {
		version,
		name: `ReelVault ${version}`,
		url: `https://github.com/ReelVault/reelvault/releases/tag/v${version}`,
		publishedAt: null,
		notes: null,
		minServerVersion: null,
		assets: [],
	};
}

function releaseState(state: {
	serverLatest: AdminUpdateRelease | null;
	webLatest: AdminUpdateRelease | null;
	serverUpdateAvailable: boolean;
	webUpdateAvailable: boolean;
	webRequiresServerUpdate?: boolean;
}): void {
	stubs.push(
		stubMethod(updateCheckService, "checkLatest", () => Promise.resolve()),
		stubMethod(updateCheckService, "getState", () => ({
			...state,
			webRequiresServerUpdate: state.webRequiresServerUpdate ?? false,
			lastCheckedAt: null,
			serverLastError: null,
			webLastError: null,
		})),
	);
}

async function seedAdministrators(): Promise<void> {
	await insertUsers(db.client(), [
		{ id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" },
		{ id: "admin-2", name: "Second", email: "second@example.com", emailVerified: true, role: "admin" },
	]);
}

async function updateNotifications() {
	return await selectNotifications(db.client());
}

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

describe("updateNotificationService.notifyIfUpdateAvailable", () => {
	test("notifies every administrator once for each component that has a newer release", async () => {
		await seedAdministrators();
		releaseState({ serverLatest: release("1.0.1"), webLatest: release("0.2.0"), serverUpdateAvailable: true, webUpdateAvailable: true });

		expect(await updateNotificationService.notifyIfUpdateAvailable(true)).toBe(true);

		const rows = await updateNotifications();
		expect(rows).toHaveLength(4);
		expect(rows.map((row) => [row.userId, row.data.component]).toSorted((a, b) => a.join("|").localeCompare(b.join("|")))).toEqual([
			["admin-1", "server"],
			["admin-1", "web"],
			["admin-2", "server"],
			["admin-2", "web"],
		]);
		expect(rows.find((row) => row.data.component === "server")).toMatchObject({
			type: "update_available",
			title: "notification.update_available_server",
			link: "/admin/updates",
			data: { version: "1.0.1", component: "server", releaseUrl: "https://github.com/ReelVault/reelvault/releases/tag/v1.0.1" },
		});
	});

	test("does not notify again for a release that was already announced", async () => {
		await seedAdministrators();
		await insertNotifications(db.client(), {
			id: "n-old",
			userId: "admin-1",
			type: "update_available",
			title: "notification.update_available_server",
			data: { version: "1.0.1", component: "server" },
		});
		releaseState({ serverLatest: release("1.0.1"), webLatest: null, serverUpdateAvailable: true, webUpdateAvailable: false });

		expect(await updateNotificationService.notifyIfUpdateAvailable(true)).toBe(false);
		expect(await updateNotifications()).toHaveLength(1);
	});

	test("a second run for the same release sends nothing new", async () => {
		await seedAdministrators();
		releaseState({ serverLatest: release("1.0.1"), webLatest: null, serverUpdateAvailable: true, webUpdateAvailable: false });

		expect(await updateNotificationService.notifyIfUpdateAvailable(true)).toBe(true);
		expect(await updateNotificationService.notifyIfUpdateAvailable(true)).toBe(false);
		expect(await updateNotifications()).toHaveLength(2);
	});

	test("skips the web release while it needs a newer server first", async () => {
		await seedAdministrators();
		releaseState({
			serverLatest: null,
			webLatest: release("0.3.0"),
			serverUpdateAvailable: false,
			webUpdateAvailable: true,
			webRequiresServerUpdate: true,
		});

		expect(await updateNotificationService.notifyIfUpdateAvailable(true)).toBe(false);
		expect(await updateNotifications()).toEqual([]);
	});
});

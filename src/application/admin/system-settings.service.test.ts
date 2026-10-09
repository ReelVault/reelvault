import { afterEach, describe, expect, test } from "bun:test";
import { adminAuditService } from "@/application/admin/admin-audit.service";
import { libraryWatcherService } from "@/application/libraries/watching/library-watcher.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import { systemSettingsRepository } from "@/database/repositories/system-settings.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { systemSettingsService } from "./system-settings.service";

const stubs: Array<{ restore(): void }> = [];

function stubSettingsPersistence() {
	const setMany = stubMethod(systemSettingsRepository, "setMany", () => Promise.resolve());
	const list = stubMethod(systemSettingsRepository, "list", () => Promise.resolve([]));
	stubs.push(setMany, list);

	return setMany;
}

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	systemSettingsStore.clearRuntimeValues();
});

describe("systemSettingsService.updateSettings validation", () => {
	test("refuses to enable two-factor enforcement while no administrator has two-factor enabled", async () => {
		const setMany = stubSettingsPersistence();
		stubs.push(stubMethod(usersRepository, "countAdministratorsWithTwoFactor", () => Promise.resolve(0)));

		await expect(systemSettingsService.updateSettings({ "auth.enforceTwoFactor": true })).rejects.toMatchObject({
			code: "auth.two_factor_requires_admin",
		});
		expect(setMany.calls).toEqual([]);
	});

	test("allows enabling two-factor enforcement once an administrator has two-factor enabled", async () => {
		const setMany = stubSettingsPersistence();
		stubs.push(stubMethod(usersRepository, "countAdministratorsWithTwoFactor", () => Promise.resolve(1)));

		await systemSettingsService.updateSettings({ "auth.enforceTwoFactor": true });

		expect(setMany.calls.length).toBe(1);
	});

	test("rejects an invalid value instead of persisting the default", async () => {
		const setMany = stubSettingsPersistence();

		await expect(systemSettingsService.updateSettings({ "stream.maxSessions": "eight" })).rejects.toMatchObject({
			code: "admin.settings.invalid_value",
		});

		expect(setMany.calls.length).toBe(0);
		expect(systemSettingsStore.get("stream.maxSessions")).not.toBe("eight");
	});

	test("rejects an out-of-range value", async () => {
		const setMany = stubSettingsPersistence();

		await expect(systemSettingsService.updateSettings({ "stream.maxSessions": 999 })).rejects.toMatchObject({
			code: "admin.settings.invalid_value",
		});

		expect(setMany.calls.length).toBe(0);
	});

	test("persists a valid value", async () => {
		const setMany = stubSettingsPersistence();

		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 });

		expect(setMany.calls.length).toBe(1);
		expect(systemSettingsStore.get("stream.maxSessions")).toBe(8);
	});
});

describe("systemSettingsService provider cache TTL", () => {
	test("rebuilds the provider result caches when their TTL changes", async () => {
		stubSettingsPersistence();
		const reset = stubMethod(providerService, "resetCaches", () => undefined);
		stubs.push(reset);

		await systemSettingsService.updateSettings({ "plugins.providers.detailsCacheTtlMs": 60_000 });

		expect(reset.calls.length).toBe(1);
	});

	test("leaves the provider caches alone when another setting changes", async () => {
		stubSettingsPersistence();
		const reset = stubMethod(providerService, "resetCaches", () => undefined);
		stubs.push(reset);

		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 });

		expect(reset.calls.length).toBe(0);
	});
});

describe("systemSettingsService field-level feedback", () => {
	test("an out-of-range number reports the allowed bounds", async () => {
		stubSettingsPersistence();

		await expect(systemSettingsService.updateSettings({ "stream.maxSessions": 999 })).rejects.toMatchObject({
			code: "admin.settings.invalid_value",
			params: { key: "stream.maxSessions", min: 1, max: 100 },
		});
	});

	test("an unknown key is rejected instead of being silently dropped", async () => {
		const setMany = stubSettingsPersistence();

		await expect(systemSettingsService.updateSettings({ "stream.maxSessions": 4, "stream.doesNotExist": true })).rejects.toMatchObject({
			code: "admin.settings.unknown_key",
			params: { key: "stream.doesNotExist" },
		});
		expect(setMany.calls.length).toBe(0);
	});

	test("number settings are listed with their bounds", async () => {
		stubSettingsPersistence();

		const grouped = await systemSettingsService.getAll();
		const item = Object.values(grouped)
			.flat()
			.find((entry) => entry.key === "stream.maxSessions");

		expect(item).toMatchObject({ type: "number", min: 1, max: 100 });
	});

	test("settings carry their unit, and only the restart-only ones say so", async () => {
		stubSettingsPersistence();

		const grouped = await systemSettingsService.getAll();
		const byKey = new Map(
			Object.values(grouped)
				.flat()
				.map((entry) => [entry.key, entry]),
		);

		expect(byKey.get("auth.sessionLifetimeDays")).toMatchObject({ unit: "days", restartRequired: true });
		expect(byKey.get("stream.hlsSegmentDurationSeconds")).toMatchObject({ unit: "s", restartRequired: true });
		expect(byKey.get("system.resources.monitoringIntervalMs")).toMatchObject({ unit: "ms" });
		expect(byKey.get("system.resources.monitoringIntervalMs")).not.toHaveProperty("restartRequired");
		expect(byKey.get("stream.maxSessions")).not.toHaveProperty("restartRequired");
	});

	test("the limits added for QOL are listed with their bounds", async () => {
		stubSettingsPersistence();

		const grouped = await systemSettingsService.getAll();
		const byKey = new Map(
			Object.values(grouped)
				.flat()
				.map((entry) => [entry.key, entry]),
		);

		expect(byKey.get("stream.hlsMaxMuxingQueueSize")).toMatchObject({ min: 512, max: 8192, default: 2048 });
		expect(byKey.get("downloads.maxConcurrentPerProfile")).toMatchObject({ min: 1, max: 5, default: 1 });
		expect(byKey.get("trickplay.maxFramesPerFile")).toMatchObject({ min: 300, max: 5000, default: 1200 });
		expect(byKey.get("plugins.blobs.retentionDays")).toMatchObject({ min: 1, max: 365, default: 30 });
		expect(byKey.get("plugins.notifications.maxPerDayPerPlugin")).toMatchObject({ min: 0, max: 1000, default: 100 });
	});
});

describe("systemSettingsService default pruning", () => {
	test("saving the definition default drops the override instead of persisting it", async () => {
		const setMany = stubSettingsPersistence();
		const deleteMany = stubMethod(systemSettingsRepository, "deleteMany", () => Promise.resolve());
		stubs.push(deleteMany);

		await systemSettingsService.updateSettings({ "stream.maxSessions": 5 });

		expect(setMany.calls.length).toBe(0);
		expect(deleteMany.calls[0]?.[0]).toEqual(["stream.maxSessions"]);
		expect(systemSettingsStore.getWithMeta("stream.maxSessions").isCustom).toBe(false);
	});

	test("an empty string is accepted for a setting whose default is empty", async () => {
		stubSettingsPersistence();
		stubs.push(stubMethod(systemSettingsRepository, "deleteMany", () => Promise.resolve()));

		await systemSettingsService.updateSettings({ "plugins.http.allowedDomains": "" });

		expect(systemSettingsStore.get("plugins.http.allowedDomains")).toBe("");
	});

	test("an empty string is still rejected for a setting with a non-empty default", async () => {
		stubSettingsPersistence();

		await expect(systemSettingsService.updateSettings({ "ffprobe.path": "" })).rejects.toMatchObject({
			code: "admin.settings.invalid_value",
		});
	});
});

describe("systemSettingsService watcher side effects", () => {
	test("re-syncs watchers when the fallback interval changes", async () => {
		stubSettingsPersistence();
		const syncWatchers = stubMethod(libraryWatcherService, "syncWatchers", () => Promise.resolve());
		stubs.push(syncWatchers);

		await systemSettingsService.updateSettings({ "scanning.watcherFallbackIntervalMinutes": 45 });

		expect(syncWatchers.calls.length).toBe(1);
	});
});

describe("systemSettingsService audit trail", () => {
	test("the update entry carries the resulting values, not an empty object", async () => {
		stubSettingsPersistence();
		const recorded: unknown[] = [];
		stubs.push(
			stubMethod(adminAuditService, "record", (entry: unknown) => {
				recorded.push(entry);

				return Promise.resolve();
			}),
		);

		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 });
		// recordAuditSafe detaches its write — one macrotask flushes the microtask chain.
		await Bun.sleep(0);

		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ after: { "stream.maxSessions": 8 } });
	});
});

describe("systemSettingsService export and import", () => {
	test("export carries the format tag and the current value of each setting", async () => {
		stubSettingsPersistence();

		const exported = await systemSettingsService.exportSettings();

		expect(exported).toMatchObject({ format: "reelvault.settings", formatVersion: 1 });
		expect(exported.settings["stream.maxSessions"]).toBe(systemSettingsStore.get("stream.maxSessions"));
	});

	test("import applies the listed settings through the update validation", async () => {
		const setMany = stubSettingsPersistence();

		await systemSettingsService.importSettings({
			format: "reelvault.settings",
			formatVersion: 1,
			settings: { "stream.maxSessions": 8 },
		});

		expect(setMany.calls).toHaveLength(1);
		expect(systemSettingsStore.get("stream.maxSessions")).toBe(8);
	});

	test("import refuses the whole file when one key is unknown", async () => {
		const setMany = stubSettingsPersistence();

		await expect(
			systemSettingsService.importSettings({
				format: "reelvault.settings",
				formatVersion: 1,
				settings: { "stream.maxSessions": 8, "stream.doesNotExist": 1 },
			}),
		).rejects.toMatchObject({ code: "admin.settings.unknown_key" });

		expect(setMany.calls).toHaveLength(0);
	});
});

describe("systemSettingsService change tracking", () => {
	test("saving records the administrator on each value and tells the other admin sessions which keys changed", async () => {
		const setMany = stubSettingsPersistence();
		const broadcast = stubMethod(realtimeService, "broadcastToAdmins", () => undefined);
		stubs.push(broadcast);

		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 }, { actorUserId: "admin-1" });

		expect(setMany.calls[0]?.[0]).toEqual([expect.objectContaining({ key: "stream.maxSessions", lastModifiedBy: "admin-1" })]);
		expect(broadcast.calls).toEqual([
			["settings:changed", { keys: ["stream.maxSessions"], actorUserId: "admin-1", updatedAt: expect.any(String) }],
		]);
	});
});

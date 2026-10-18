import { afterEach, describe, expect, test } from "bun:test";
import { libraryWatcherService } from "@/app/libraries/watching/library-watcher.service";
import { systemSettingsRepository } from "@/app/repositories/system-settings.repository";
import { systemSettingsStore } from "@/config/system-settings.store";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { currentLogLevel, setLogLevel } from "@/utils/logger.utils";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body.cache";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { selectAdminAuditLogs } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { systemSettingsService } from "./system-settings.service";

// Saved settings are read back from the migrated test database. Stubbed: the watcher
// re-sync (filesystem watchers), the provider cache reset and the admin realtime broadcast,
// which are outside the process's own data.
const db = useTestDatabase();
const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	systemSettingsStore.clearRuntimeValues();
});

describe("systemSettingsService.updateSettings validation", () => {
	test("refuses to enable two-factor enforcement while no administrator has two-factor enabled", async () => {
		await expect(systemSettingsService.updateSettings({ "auth.enforceTwoFactor": true })).rejects.toMatchObject({
			code: "auth.two_factor_requires_admin",
		});

		expect(await systemSettingsRepository.list()).toEqual([]);
		expect(systemSettingsStore.get("auth.enforceTwoFactor")).toBe(false);
	});
});

describe("systemSettingsService log level", () => {
	test("a stored log level applies to the running logger without a restart", async () => {
		const previous = currentLogLevel();
		try {
			await systemSettingsService.updateSettings({ "system.logs.level": "warn" });

			expect(currentLogLevel()).toBe("warn");
		} finally {
			setLogLevel(previous);
		}
	});
});

describe("systemSettingsService profile defaults", () => {
	const profileListKey = responseCacheKey({ pathWithQuery: "/v1/profiles?limit=20", cookie: "c", profileId: "p", auth: "", apiKey: "" });

	function seedProfileList(): void {
		setCachedResponseBody(profileListKey, { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() });
	}

	test("saving a profile default flushes cached API responses", async () => {
		seedProfileList();

		await systemSettingsService.updateSettings({ "profiles.defaultPreferences.resumeRewindSeconds": 5 });

		expect(getCachedResponseBody(profileListKey)).toBeUndefined();
	});
});

describe("systemSettingsService provider cache TTL", () => {
	test("rebuilds the provider result caches when their TTL changes", async () => {
		const reset = stubMethod(providerService, "resetCaches", () => undefined);
		stubs.push(reset);

		await systemSettingsService.updateSettings({ "plugins.providers.detailsCacheTtlMs": 60_000 });

		expect(reset.calls.length).toBe(1);
	});
});

describe("systemSettingsService field-level feedback", () => {
	test("an unknown key refuses the whole batch, so the valid key in it is not saved either", async () => {
		await expect(systemSettingsService.updateSettings({ "stream.maxSessions": 4, "stream.doesNotExist": true })).rejects.toMatchObject({
			code: "admin.settings.unknown_key",
			params: { key: "stream.doesNotExist" },
		});

		expect(await systemSettingsRepository.list()).toEqual([]);
		expect(systemSettingsStore.get("stream.maxSessions")).toBe(5);
	});
});

describe("systemSettingsService default pruning", () => {
	test("saving the definition default drops the stored override instead of persisting the default", async () => {
		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 });
		expect(await systemSettingsRepository.list()).toEqual([expect.objectContaining({ key: "stream.maxSessions", value: "8" })]);

		await systemSettingsService.updateSettings({ "stream.maxSessions": 5 });

		expect(await systemSettingsRepository.list()).toEqual([]);
		expect(systemSettingsStore.getWithMeta("stream.maxSessions").isCustom).toBe(false);
	});
});

describe("systemSettingsService watcher side effects", () => {
	test("re-syncs watchers when the fallback interval changes", async () => {
		const syncWatchers = stubMethod(libraryWatcherService, "syncWatchers", () => Promise.resolve());
		stubs.push(syncWatchers);

		await systemSettingsService.updateSettings({ "scanning.watcherFallbackIntervalMinutes": 45 });

		expect(syncWatchers.calls.length).toBe(1);
	});
});

describe("systemSettingsService audit trail", () => {
	test("the update entry carries the resulting values, not an empty object", async () => {
		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 });
		// recordAuditSafe detaches its write — one macrotask flushes the microtask chain.
		await Bun.sleep(0);

		const [entry] = await selectAdminAuditLogs(db.client());
		expect(entry).toMatchObject({ action: "update", resourceType: "system_settings" });
		expect(JSON.parse(entry?.afterJson ?? "null")).toEqual({ "stream.maxSessions": 8 });
	});
});

describe("systemSettingsService export and import", () => {
	test("import applies the listed settings through the update validation", async () => {
		await systemSettingsService.importSettings({
			format: "reelvault.settings",
			formatVersion: 1,
			settings: { "stream.maxSessions": 8 },
		});

		expect(await systemSettingsRepository.list()).toEqual([expect.objectContaining({ key: "stream.maxSessions", value: "8" })]);
		expect(systemSettingsStore.get("stream.maxSessions")).toBe(8);
	});

	test("import refuses the whole file when one key is unknown", async () => {
		await expect(
			systemSettingsService.importSettings({
				format: "reelvault.settings",
				formatVersion: 1,
				settings: { "stream.maxSessions": 8, "stream.doesNotExist": 1 },
			}),
		).rejects.toMatchObject({ code: "admin.settings.unknown_key" });

		expect(await systemSettingsRepository.list()).toEqual([]);
	});
});

describe("systemSettingsService change tracking", () => {
	test("saving records the administrator on each value and tells the other admin sessions which keys changed", async () => {
		const broadcast = stubMethod(realtimeService, "broadcastToAdmins", () => undefined);
		stubs.push(broadcast);

		await systemSettingsService.updateSettings({ "stream.maxSessions": 8 }, { actorUserId: "admin-1" });

		expect(await systemSettingsRepository.list()).toEqual([
			expect.objectContaining({ key: "stream.maxSessions", lastModifiedBy: "admin-1" }),
		]);
		expect(broadcast.calls).toEqual([
			["settings:changed", { keys: ["stream.maxSessions"], actorUserId: "admin-1", updatedAt: expect.any(String) }],
		]);
	});
});

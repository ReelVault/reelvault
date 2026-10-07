import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { systemSettingsRepository } from "@/database/repositories/system-settings.repository";
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

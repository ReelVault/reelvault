import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "./system-settings.store";

describe("SystemSettingsStore", () => {
	// The store is process-wide, so every test starts from the defaults.
	afterEach(() => {
		systemSettingsStore.clearRuntimeValues();
	});

	test("returns defaults for untouched settings", () => {
		expect(systemSettingsStore.get("system.resources.cpuProfile")).toBe("balanced");
		expect(systemSettingsStore.hasCustom("system.resources.cpuProfile")).toBe(false);
	});

	test("getWithMeta reports whether the value is a runtime override", () => {
		systemSettingsStore.setRuntimeValue("system.resources.cpuProfile", "performance");
		expect(systemSettingsStore.getWithMeta("system.resources.cpuProfile")).toEqual({ value: "performance", isCustom: true });
		expect(systemSettingsStore.getWithMeta("system.resources.diskThresholdPercent").isCustom).toBe(false);
	});

	test("array settings come back as copies, never the shared default", () => {
		// Mutating a returned array must not leak into the next read.
		const origins = systemSettingsStore.get("network.allowedOrigins");
		origins.push("mutated-entry");
		expect(systemSettingsStore.get("network.allowedOrigins")).not.toContain("mutated-entry");
	});

	test("an out-of-range value falls back to the default instead of being stored", () => {
		const defaultValue = systemSettingsStore.get("system.resources.maxCpuCores");

		// The definition's range is 0-256, so 9999 is not stored as given.
		systemSettingsStore.setRuntimeValue("system.resources.maxCpuCores", 9999);

		expect(systemSettingsStore.get("system.resources.maxCpuCores")).toBe(defaultValue);
	});

	test("clearRuntimeValues restores every default", () => {
		systemSettingsStore.setRuntimeValue("system.resources.cpuProfile", "conservative");
		expect(systemSettingsStore.get("system.resources.cpuProfile")).toBe("conservative");

		systemSettingsStore.clearRuntimeValues();
		expect(systemSettingsStore.get("system.resources.cpuProfile")).toBe("balanced");
		expect(systemSettingsStore.hasCustom("system.resources.cpuProfile")).toBe(false);
	});

	test("reading an unknown key throws instead of returning undefined", () => {
		expect(() => systemSettingsStore.get("system.resources.doesNotExist")).toThrow(
			expect.objectContaining({ category: "internal", code: "settings.unknown_key" }),
		);
	});

	test("revision bumps on every write so derived views can memoize", () => {
		const before = systemSettingsStore.revision;

		systemSettingsStore.setRuntimeValue("system.resources.cpuProfile", "performance");
		const afterSet = systemSettingsStore.revision;
		expect(afterSet).toBeGreaterThan(before);

		systemSettingsStore.deleteRuntimeValues(["system.resources.cpuProfile"]);
		expect(systemSettingsStore.revision).toBeGreaterThan(afterSet);

		systemSettingsStore.clearRuntimeValues();
		expect(systemSettingsStore.revision).toBeGreaterThan(afterSet);
	});
});

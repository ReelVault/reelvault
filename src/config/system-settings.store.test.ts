import { describe, expect, test } from "bun:test";
import { systemSettingsStore } from "./system-settings.store";

describe("SystemSettingsStore", () => {
	test("returns defaults for untouched settings", () => {
		expect(systemSettingsStore.get("system.resources.cpuProfile")).toBe("balanced");
		expect(systemSettingsStore.hasCustom("system.resources.cpuProfile")).toBe(false);
	});

	test("getWithMeta reports whether the value is a runtime override", () => {
		try {
			systemSettingsStore.setRuntimeValue("system.resources.cpuProfile", "performance");
			expect(systemSettingsStore.getWithMeta("system.resources.cpuProfile")).toEqual({ value: "performance", isCustom: true });
			expect(systemSettingsStore.getWithMeta("system.resources.diskThresholdPercent").isCustom).toBe(false);
		} finally {
			systemSettingsStore.clearRuntimeValues();
		}
	});

	test("array settings come back as copies, never the shared default", () => {
		// Mutating a returned array must not leak into the next read.
		const origins = systemSettingsStore.get("network.allowedOrigins");
		origins.push("mutated-entry");
		expect(systemSettingsStore.get("network.allowedOrigins")).not.toContain("mutated-entry");
	});

	test("setRuntimeValue round-trips through the definition — invalid values never reach the runtime", () => {
		try {
			// Outside the definition range (0-256): the round-trip resets it to the default.
			systemSettingsStore.setRuntimeValue("system.resources.maxCpuCores", 9999);
			expect(systemSettingsStore.get("system.resources.maxCpuCores")).not.toBe(9999);
		} finally {
			systemSettingsStore.clearRuntimeValues();
		}
	});

	test("clearRuntimeValues restores every default", () => {
		systemSettingsStore.setRuntimeValue("system.resources.cpuProfile", "conservative");
		expect(systemSettingsStore.get("system.resources.cpuProfile")).toBe("conservative");

		systemSettingsStore.clearRuntimeValues();
		expect(systemSettingsStore.get("system.resources.cpuProfile")).toBe("balanced");
		expect(systemSettingsStore.hasCustom("system.resources.cpuProfile")).toBe(false);
	});

	test("reading an unknown key throws instead of returning undefined", () => {
		expect(() => systemSettingsStore.get("system.resources.doesNotExist")).toThrow("Unknown system setting key");
	});
});

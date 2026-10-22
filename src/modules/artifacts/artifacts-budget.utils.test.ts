import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import {
	assertCoreArtifactsBudget,
	computeAutoBudgetBytes,
	isStorageBudgetError,
	resolveCoreArtifactsBudgetBytes,
} from "./artifacts-budget.utils";

const GIBIBYTE = 1024 * 1024 * 1024;

// The volume is injected, so no case depends on the free space of the machine running it.
const roomyVolume = () => Promise.resolve({ totalBytes: 100 * GIBIBYTE, freeBytes: 50 * GIBIBYTE });

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

describe("computeAutoBudgetBytes", () => {
	test("clamps 5% of the volume capacity to 5–100 GiB", () => {
		expect(computeAutoBudgetBytes(40 * GIBIBYTE)).toBe(5 * GIBIBYTE);
		expect(computeAutoBudgetBytes(200 * GIBIBYTE)).toBe(10 * GIBIBYTE);
		expect(computeAutoBudgetBytes(4096 * GIBIBYTE)).toBe(100 * GIBIBYTE);
	});
});

describe("resolveCoreArtifactsBudgetBytes", () => {
	test("returns the configured budget in bytes when set", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 7);

		expect(await resolveCoreArtifactsBudgetBytes()).toBe(7 * GIBIBYTE);
	});
});

describe("assertCoreArtifactsBudget", () => {
	test("rejects writes above the configured budget", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);

		await expect(assertCoreArtifactsBudget(2 * GIBIBYTE, 1, roomyVolume)).rejects.toMatchObject({
			code: "artifact.storage_budget_exceeded",
		});
	});

	test("classifies the budget error for skip handling", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);

		const failure = await assertCoreArtifactsBudget(2 * GIBIBYTE, 1, roomyVolume).catch((error: unknown) => error);

		expect(isStorageBudgetError(failure)).toBe(true);
		expect(isStorageBudgetError(new Error("nope"))).toBe(false);
	});

	test("accepts writes within the configured budget", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 10);

		await expect(assertCoreArtifactsBudget(1, 1, roomyVolume)).resolves.toBeUndefined();
	});

	test("refuses a write that would leave the artifacts volume under one gibibyte free", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 10);
		const nearlyFull = () => Promise.resolve({ totalBytes: 100 * GIBIBYTE, freeBytes: 2 * GIBIBYTE });

		await expect(assertCoreArtifactsBudget(1, 2 * GIBIBYTE, nearlyFull)).rejects.toMatchObject({
			code: "artifact.storage_budget_exceeded",
		});
	});

	test("accepts a write that leaves exactly one gibibyte free", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 10);
		const exactlyEnough = () => Promise.resolve({ totalBytes: 100 * GIBIBYTE, freeBytes: 3 * GIBIBYTE });

		await expect(assertCoreArtifactsBudget(1, 2 * GIBIBYTE, exactlyEnough)).resolves.toBeUndefined();
	});
});

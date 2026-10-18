import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import {
	assertCoreArtifactsBudget,
	computeAutoBudgetBytes,
	isStorageBudgetError,
	resolveCoreArtifactsBudgetBytes,
} from "./artifacts-budget.utils";

const GIBIBYTE = 1024 * 1024 * 1024;

// The settings store is process-wide, so every test resets it. Artifact totals are cached until invalidated.
beforeEach(() => {
	mediaArtifactsService.invalidateByteTotals();
});

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

describe("computeAutoBudgetBytes", () => {
	test("clamps 5% of the volume capacity to 5–100 GB", () => {
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

		await expect(assertCoreArtifactsBudget(2 * GIBIBYTE, 1)).rejects.toMatchObject({
			code: "artifact.storage_budget_exceeded",
		});
	});

	test("classifies the budget error for skip handling", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 1);

		const error = await assertCoreArtifactsBudget(2 * GIBIBYTE, 1).catch((caught: unknown) => caught);

		expect(isStorageBudgetError(error)).toBe(true);
		expect(isStorageBudgetError(new Error("nope"))).toBe(false);
	});

	test("accepts writes within the configured budget", async () => {
		systemSettingsStore.setRuntimeValue("system.artifacts.coreMaxStorageGb", 10);

		await expect(assertCoreArtifactsBudget(1, 1)).resolves.toBeUndefined();
	});
});

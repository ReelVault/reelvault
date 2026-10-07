import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { stubMethod } from "../../../tests/helpers/method-stub";
import {
	assertCoreArtifactsBudget,
	computeAutoBudgetBytes,
	isStorageBudgetError,
	resolveCoreArtifactsBudgetBytes,
	writeCoreArtifact,
} from "./artifacts-budget.utils";
import { mediaArtifactsService } from "./media-artifacts.service";

const GIBIBYTE = 1024 * 1024 * 1024;
const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

function stubConfiguredBudget(gigabytes: number): void {
	activeStubs.push(
		stubMethod(systemSettingsStore, "get", (key: string) => (key === "system.artifacts.coreMaxStorageGb" ? gigabytes : undefined)),
	);
}

describe("computeAutoBudgetBytes", () => {
	test("clamps 5% of the volume capacity to 5–100 GB", () => {
		expect(computeAutoBudgetBytes(40 * GIBIBYTE)).toBe(5 * GIBIBYTE);
		expect(computeAutoBudgetBytes(200 * GIBIBYTE)).toBe(10 * GIBIBYTE);
		expect(computeAutoBudgetBytes(4096 * GIBIBYTE)).toBe(100 * GIBIBYTE);
	});
});

describe("resolveCoreArtifactsBudgetBytes", () => {
	test("returns the configured budget in bytes when set", async () => {
		stubConfiguredBudget(7);

		expect(await resolveCoreArtifactsBudgetBytes()).toBe(7 * GIBIBYTE);
	});
});

describe("assertCoreArtifactsBudget", () => {
	test("rejects writes above the configured budget", async () => {
		stubConfiguredBudget(1);

		await expect(assertCoreArtifactsBudget(2 * GIBIBYTE, 1)).rejects.toMatchObject({
			code: "artifact.storage_budget_exceeded",
		});
	});

	test("classifies the budget error for skip handling", async () => {
		stubConfiguredBudget(1);

		const error = await assertCoreArtifactsBudget(2 * GIBIBYTE, 1).catch((caught: unknown) => caught);

		expect(isStorageBudgetError(error)).toBe(true);
		expect(isStorageBudgetError(new Error("nope"))).toBe(false);
	});

	test("accepts writes within the configured budget", async () => {
		stubConfiguredBudget(10);

		await expect(assertCoreArtifactsBudget(1, 1)).resolves.toBeUndefined();
	});
});

describe("writeCoreArtifact", () => {
	test("writes as the core owner with the budget gate attached", async () => {
		let capturedOwner: string | undefined;
		let gate: unknown;
		activeStubs.push(
			stubMethod(mediaArtifactsService, "write", (ownerId: string, artifact: unknown, options: unknown) => {
				capturedOwner = ownerId;
				gate = (options as { assertWithinQuota?: unknown } | undefined)?.assertWithinQuota;

				return Promise.resolve(artifact);
			}),
		);

		await writeCoreArtifact({
			mediaFileId: "mf-1",
			kind: "trickplay",
			contentType: "text/vtt",
			content: new TextEncoder().encode("WEBVTT"),
		});

		expect(capturedOwner).toBe("core");
		expect(typeof gate).toBe("function");
	});
});

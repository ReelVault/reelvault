import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { serverConfig } from "@/server.config";
import { assertFFProbeAvailable } from "./ffprobe.environment";
import { ffProbeService } from "./ffprobe.service";

describe("FFprobe integration", () => {
	// Real-binary probe — skipped where ffprobe is absent.
	const hasFfprobe = ffProbeService.isAvailable();

	test.skipIf(!hasFfprobe)("checks availability and executes through the integration boundary", () => {
		expect(ffProbeService.isAvailable()).toBe(true);
		expect(assertFFProbeAvailable()).toBeTruthy();
	});

	test("respects custom ffprobe.path setting", () => {
		const originalPath = serverConfig.ffprobe.path;
		try {
			systemSettingsStore.setRuntimeValue("ffprobe.path", "non-existent-ffprobe-binary");
			expect(serverConfig.ffprobe.path).toBe("non-existent-ffprobe-binary");
			expect(ffProbeService.isAvailable()).toBe(false);
			expect(() => assertFFProbeAvailable()).toThrow("Missing required media tools");
		} finally {
			systemSettingsStore.setRuntimeValue("ffprobe.path", originalPath);
		}
	});

	test("allows custom finder in assertFFProbeAvailable", () => {
		const path = assertFFProbeAvailable((cmd) => `/custom/bin/${cmd}`);
		expect(path).toContain("/custom/bin/");
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());

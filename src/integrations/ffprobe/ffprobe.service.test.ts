import { afterEach, describe, expect, test } from "bun:test";
import { which } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { assertFFProbeAvailable } from "./ffprobe.environment";

describe("FFprobe integration", () => {
	test("the ffprobe binary it locates runs and reports its version", async () => {
		const proc = Bun.spawn([assertFFProbeAvailable(), "-version"], { stdout: "pipe", stderr: "ignore" });

		expect(await new Response(proc.stdout).text()).toStartWith("ffprobe version");
		expect(await proc.exited).toBe(0);
	});

	test("respects custom ffprobe.path setting", () => {
		systemSettingsStore.setRuntimeValue("ffprobe.path", "non-existent-ffprobe-binary");

		expect(serverConfig.ffprobe.path).toBe("non-existent-ffprobe-binary");
		expect(Boolean(which(serverConfig.ffprobe.path))).toBe(false);
		expect(() => assertFFProbeAvailable()).toThrow(expect.objectContaining({ category: "internal", code: "media_tools.missing" }));
	});

	test("resolves the configured binary through the finder it is given", () => {
		const path = assertFFProbeAvailable((cmd) => `/custom/bin/${cmd}`);

		expect(path).toBe(`/custom/bin/${serverConfig.ffprobe.path}`);
	});
});

// The settings store is process-global — never leak overrides into other test files.
afterEach(() => systemSettingsStore.clearRuntimeValues());

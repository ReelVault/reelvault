import { afterEach, describe, expect, test } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { env } from "@/env";
import { serverConfig } from "@/server.config";

describe("serverConfig tool paths", () => {
	afterEach(() => {
		systemSettingsStore.clearRuntimeValues();
		env.APP_FFMPEG_PATH = undefined;
		env.APP_FFPROBE_PATH = undefined;
	});

	test("defaults to the command names resolved through PATH", () => {
		expect(serverConfig.ffmpeg.path).toBe("ffmpeg");
		expect(serverConfig.ffprobe.path).toBe("ffprobe");
	});

	test("uses the environment fallback when the setting is not customized", () => {
		env.APP_FFMPEG_PATH = "/bundled/bin/ffmpeg";
		env.APP_FFPROBE_PATH = "/bundled/bin/ffprobe";

		expect(serverConfig.ffmpeg.path).toBe("/bundled/bin/ffmpeg");
		expect(serverConfig.ffprobe.path).toBe("/bundled/bin/ffprobe");
	});

	test("a customized setting wins over the environment fallback", () => {
		env.APP_FFMPEG_PATH = "/bundled/bin/ffmpeg";
		env.APP_FFPROBE_PATH = "/bundled/bin/ffprobe";
		systemSettingsStore.setRuntimeValue("ffmpeg.path", "/custom/ffmpeg");
		systemSettingsStore.setRuntimeValue("ffprobe.path", "/custom/ffprobe");

		expect(serverConfig.ffmpeg.path).toBe("/custom/ffmpeg");
		expect(serverConfig.ffprobe.path).toBe("/custom/ffprobe");
	});

	test("blank environment values are ignored", () => {
		env.APP_FFMPEG_PATH = "   ";
		env.APP_FFPROBE_PATH = "";

		expect(serverConfig.ffmpeg.path).toBe("ffmpeg");
		expect(serverConfig.ffprobe.path).toBe("ffprobe");
	});
});

describe("serverConfig worker time limits", () => {
	afterEach(() => {
		systemSettingsStore.clearRuntimeValues();
	});

	test("the library scan and download time limits follow the live settings", () => {
		systemSettingsStore.setRuntimeValue("workers.definitions.libraryScan.timeoutMs", 5_400_000);
		systemSettingsStore.setRuntimeValue("workers.definitions.downloadsProcess.timeoutMs", 3_600_000);

		expect(serverConfig.workers.definitions.libraryScan.timeoutMs).toBe(5_400_000);
		expect(serverConfig.workers.definitions.downloadsProcess.timeoutMs).toBe(3_600_000);
	});
});

describe("serverConfig HLS segment length", () => {
	afterEach(() => systemSettingsStore.clearRuntimeValues());

	test("is fixed for the lifetime of the process so running transcodes keep their segment grid", () => {
		const atBoot = serverConfig.stream.hlsSegmentDurationSeconds;
		systemSettingsStore.setRuntimeValue("stream.hlsSegmentDurationSeconds", atBoot + 4);

		expect(serverConfig.stream.hlsSegmentDurationSeconds).toBe(atBoot);
	});
});

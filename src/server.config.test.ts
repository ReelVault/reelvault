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

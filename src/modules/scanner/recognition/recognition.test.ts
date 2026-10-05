import { describe, expect, test } from "bun:test";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { recognizeWithPluginHooks } from "../recognition/recognition";

const MEDIA_PATH = "/library/Example Movie (2024)/Example Movie (2024).mkv";

describe("recognition plugin hooks", () => {
	test("normalizes the public recognition candidate before returning it to the scanner", async () => {
		const stub = stubMethod(pluginHookBus, "runBeforeMediaRecognition", (candidate: Record<string, unknown>) => ({
			...candidate,
			title: "Canonical title",
		}));
		try {
			await expect(recognizeWithPluginHooks(MEDIA_PATH)).resolves.toMatchObject({
				type: "movie",
				identity: { title: "Canonical title", type: "movie", year: 2024 },
			});
		} finally {
			stub.restore();
		}
	});

	test("rejects an invalid transformed candidate before metadata lookup", async () => {
		const stub = stubMethod(pluginHookBus, "runBeforeMediaRecognition", (candidate: Record<string, unknown>) => ({
			...candidate,
			title: "",
		}));
		try {
			await expect(recognizeWithPluginHooks(MEDIA_PATH)).resolves.toBeNull();
		} finally {
			stub.restore();
		}
	});
});

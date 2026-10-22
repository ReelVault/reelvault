import { afterEach, describe, expect, test } from "bun:test";
import { pluginHookBus } from "@/system/extensions/plugin.hooks";
import { recognizeWithPluginHooks } from "./recognition.service";

const MEDIA_PATH = "/library/Example Movie (2024)/Example Movie (2024).mkv";
const unsubscribers: Array<() => void> = [];

afterEach(() => {
	// The hook bus is process-wide; a hook left behind would rewrite every later recognition.
	for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

describe("recognition plugin hooks", () => {
	test("returns the candidate a plugin normalized to the scanner", async () => {
		unsubscribers.push(
			pluginHookBus.register("org.example.parser", "beforeMediaRecognition", ({ candidate }) => ({
				...candidate,
				title: "Canonical title",
			})),
		);

		await expect(recognizeWithPluginHooks(MEDIA_PATH)).resolves.toMatchObject({
			type: "movie",
			identity: { title: "Canonical title", type: "movie", year: 2024 },
		});
	});

	test("returns null when a plugin transforms the candidate into an invalid one", async () => {
		unsubscribers.push(
			pluginHookBus.register("org.example.parser", "beforeMediaRecognition", ({ candidate }) => ({ ...candidate, title: "" })),
		);

		await expect(recognizeWithPluginHooks(MEDIA_PATH)).resolves.toBeNull();
	});
});

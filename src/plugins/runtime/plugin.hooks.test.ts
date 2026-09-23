import { describe, expect, test } from "bun:test";
import { rejectPluginHook } from "@sdk/plugin";
import { PluginHookBus } from "./plugin.hooks";

const candidate = {
	type: "movie" as const,
	identity: { providerId: "tmdb", entityType: "movie" as const, externalId: "123" },
	title: "Original title",
	artwork: [],
};

describe("plugin hook bus", () => {
	test("applies metadata transformations in registration order and supports unsubscribe", async () => {
		const bus = new PluginHookBus();
		const unsubscribe = bus.beforeMetadataSave("first", ({ candidate: input }) => ({ ...input, title: "Normalized title" }));
		bus.beforeMetadataSave("second", ({ candidate: input }) => ({ ...input, overview: `${input.title} overview` }));

		const result = await bus.runBeforeMetadataSave(candidate);
		expect(result).toEqual({ ...candidate, title: "Normalized title", overview: "Normalized title overview" });

		unsubscribe();
		expect(await bus.runBeforeMetadataSave(candidate)).toEqual({ ...candidate, overview: "Original title overview" });
	});

	test("propagates an explicit hook rejection but isolates ordinary hook failures", async () => {
		const bus = new PluginHookBus();
		bus.beforeMetadataSave("broken", () => {
			throw new Error("unexpected plugin failure");
		});
		bus.beforeMetadataSave("rejecting", () => rejectPluginHook("blocked by policy"));

		await expect(bus.runBeforeMetadataSave(candidate)).rejects.toThrow("blocked by policy");
	});

	test("isolates a timed out hook and continues with later hooks", async () => {
		const bus = new PluginHookBus(1);
		bus.beforeMetadataSave(
			"timed-out",
			() =>
				new Promise<never>(() => {
					// Never settles — the hook is expected to time out.
				}),
		);
		bus.beforeMetadataSave("later", ({ candidate: input }) => ({ ...input, title: "Recovered title" }));

		await expect(bus.runBeforeMetadataSave(candidate)).resolves.toEqual({ ...candidate, title: "Recovered title" });
	});

	test("normalizes a recognition candidate without exposing a file path", async () => {
		const bus = new PluginHookBus();
		bus.beforeMediaRecognition("parser", ({ candidate: input }) => ({ ...input, title: input.title.replace(/\./g, " ") }));

		await expect(
			bus.runBeforeMediaRecognition({ type: "tv_show", title: "Example.Show", year: 2024, season: 1, episode: 2 }),
		).resolves.toEqual({ type: "tv_show", title: "Example Show", year: 2024, season: 1, episode: 2 });
	});

	test("allows artifact metadata normalization but preserves its media ownership and size", async () => {
		const bus = new PluginHookBus();
		bus.beforeArtifactCreate("normalizer", ({ candidate: input }) => ({
			...input,
			kind: "preview",
			contentType: input.contentType.toLowerCase(),
		}));

		await expect(
			bus.runBeforeArtifactCreate({ mediaFileId: "file-1", kind: "trickplay", contentType: "IMAGE/WEBP", size: 42 }),
		).resolves.toEqual({ mediaFileId: "file-1", kind: "preview", contentType: "image/webp", size: 42 });

		bus.beforeArtifactCreate("invalid", ({ candidate: input }) => ({ ...input, mediaFileId: "other-file" }));
		await expect(
			bus.runBeforeArtifactCreate({ mediaFileId: "file-1", kind: "trickplay", contentType: "image/webp", size: 42 }),
		).rejects.toThrow("invalid artifact candidate");
	});
});

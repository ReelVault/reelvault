import { describe, expect, test } from "bun:test";
import { PluginHookRejection, rejectPluginHook } from "@reelvault/sdk/plugin";
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
		const unsubscribe = bus.register("first", "beforeMetadataSave", ({ candidate: input }) => ({ ...input, title: "Normalized title" }));
		bus.register("second", "beforeMetadataSave", ({ candidate: input }) => ({ ...input, overview: `${input.title} overview` }));

		const result = await bus.run("beforeMetadataSave", candidate);
		expect(result).toEqual({ ...candidate, title: "Normalized title", overview: "Normalized title overview" });

		unsubscribe();
		expect(await bus.run("beforeMetadataSave", candidate)).toEqual({ ...candidate, overview: "Original title overview" });
	});

	test("propagates an explicit hook rejection but isolates ordinary hook failures", async () => {
		const bus = new PluginHookBus();
		const ran: string[] = [];
		bus.register("broken", "beforeMetadataSave", () => {
			throw new Error("unexpected plugin failure");
		});
		bus.register("after-broken", "beforeMetadataSave", ({ candidate: input }) => {
			ran.push("after-broken");

			return { ...input, title: "Applied after failure" };
		});
		bus.register("rejecting", "beforeMetadataSave", () => rejectPluginHook("blocked by policy"));
		bus.register("after-rejection", "beforeMetadataSave", () => {
			ran.push("after-rejection");

			return undefined;
		});

		const rejection = bus.run("beforeMetadataSave", candidate);

		await expect(rejection).rejects.toBeInstanceOf(PluginHookRejection);
		await expect(rejection).rejects.toMatchObject({ name: "PluginHookRejection", message: "blocked by policy" });
		// The ordinary failure is skipped, so the next hook runs; the explicit rejection stops the chain.
		expect(ran).toEqual(["after-broken"]);
	});

	test("isolates a timed out hook and continues with later hooks", async () => {
		const bus = new PluginHookBus(1);
		bus.register(
			"timed-out",
			"beforeMetadataSave",
			() =>
				new Promise<never>(() => {
					// Never settles — the hook is expected to time out.
				}),
		);
		bus.register("later", "beforeMetadataSave", ({ candidate: input }) => ({ ...input, title: "Recovered title" }));

		await expect(bus.run("beforeMetadataSave", candidate)).resolves.toEqual({ ...candidate, title: "Recovered title" });
	});

	test("hands every hook a frozen candidate, so one plugin cannot change what the next one reads", async () => {
		const bus = new PluginHookBus();
		const seenTitles: string[] = [];
		bus.register("mutator", "beforeMetadataSave", ({ candidate: input }) => {
			Reflect.set(input, "title", "Mutated in place");

			return undefined;
		});
		bus.register("reader", "beforeMetadataSave", ({ candidate: input }) => {
			seenTitles.push(input.title);

			return undefined;
		});

		await expect(bus.run("beforeMetadataSave", candidate)).resolves.toEqual(candidate);
		expect(seenTitles).toEqual(["Original title"]);
	});

	test("runs only the hooks registered for the named hook point", async () => {
		const bus = new PluginHookBus();
		bus.register("parser", "beforeMediaRecognition", ({ candidate: input }) => ({ ...input, title: input.title.replaceAll(".", " ") }));
		bus.register("metadata", "beforeMetadataSave", ({ candidate: input }) => ({ ...input, title: "Not a recognition" }));

		await expect(
			bus.run("beforeMediaRecognition", { type: "tv_show", title: "Example.Show", year: 2024, season: 1, episode: 2 }),
		).resolves.toEqual({ type: "tv_show", title: "Example Show", year: 2024, season: 1, episode: 2 });
	});
});

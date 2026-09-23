import { describe, expect, test } from "bun:test";
import { readStored, t, updateStored } from "@sdk/plugin";
import { createPluginTestHost } from "@sdk/testing";

const Counter = t.Object({ value: t.Number() });

describe("plugin storage helpers", () => {
	test("readStored validates stored values and returns undefined when absent", async () => {
		const host = createPluginTestHost();
		expect(await readStored(host.storage, "counter", Counter)).toBeUndefined();

		await host.storage.set("counter", { value: 2 });
		expect(await readStored(host.storage, "counter", Counter)).toEqual({ value: 2 });
	});

	test("updateStored applies an atomic, validated read-modify-write", async () => {
		const host = createPluginTestHost();
		const first = await updateStored(host.storage, "counter", Counter, (previous) => ({ value: (previous?.value ?? 0) + 1 }));
		const second = await updateStored(host.storage, "counter", Counter, (previous) => ({ value: (previous?.value ?? 0) + 1 }));

		expect(first).toEqual({ value: 1 });
		expect(second).toEqual({ value: 2 });
	});
});

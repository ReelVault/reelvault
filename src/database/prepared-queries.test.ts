import { describe, expect, test } from "bun:test";
import { createPreparedQuery } from "./prepared-queries";

describe("createPreparedQuery", () => {
	test("builds once per client and reuses the prepared instance", () => {
		let builds = 0;
		const getter = createPreparedQuery<{ name: string; build: number }, { name: string }>((client) => ({
			name: client.name,
			build: ++builds,
		}));
		const first = { name: "main" };
		const second = { name: "tx" };

		const firstPrepared = getter(first);
		expect(getter(first)).toBe(firstPrepared);
		expect(builds).toBe(1);

		const secondPrepared = getter(second);
		expect(getter(second)).toBe(secondPrepared);
		expect(secondPrepared).not.toBe(firstPrepared);
		expect(builds).toBe(2);
	});
});

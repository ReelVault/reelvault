import { describe, expect, test } from "bun:test";
import { compareVariants } from "./compare";
import { Recorder } from "./recorder";
import { bench, cleanupFixtures, collectUnits, compare, fixture, group, markCollection, task } from "./registry";

describe("compareVariants", () => {
	test("declares a winner when equal passes", () => {
		const outcome = compareVariants(
			"fast vs slow",
			[
				{ name: "slow", fn: () => Array.from({ length: 500 }, (_, i) => i).reduce((a, b) => a + b, 0) },
				{ name: "fast", fn: () => 500 * 499 * 0.5 },
			],
			{ iterations: 30, equal: (a, b) => a === b },
		);
		expect(outcome.equalOk).toBe(true);
		expect(outcome.result.winner).toBe("fast");
		expect(outcome.result.rows).toContain("fast");
	});

	test("suppresses the winner when equal rejects", () => {
		const outcome = compareVariants(
			"broken pair",
			[
				{ name: "a", fn: () => 1 },
				{ name: "b", fn: () => 2 },
			],
			{ iterations: 5, equal: (a, b) => a === b },
		);
		expect(outcome.equalOk).toBe(false);
		expect(outcome.result.winner).toBe("");
	});

	test("skips verification without equal", () => {
		const outcome = compareVariants(
			"no check",
			[
				{ name: "a", fn: () => 1 },
				{ name: "b", fn: () => 2 },
			],
			{ iterations: 5 },
		);
		expect(outcome.equalOk).toBe(true);
		expect(outcome.result.winner).not.toBe("");
	});
});

describe("registry", () => {
	test("registers units in order with the active group label", () => {
		const mark = markCollection();
		bench("standalone", () => 1);
		group("grp", () => {
			bench("inside", () => 2);
		});
		compare("cmp", { variants: { a: () => 1 } });
		task("tsk", () => ({ ok: true }));
		const units = collectUnits(mark);
		expect(units.map((unit) => unit.kind)).toEqual(["bench", "bench", "compare", "task"]);
		if (units[0]?.kind === "bench") expect(units[0].group).toBe("");

		if (units[1]?.kind === "bench") expect(units[1].group).toBe("grp");
	});

	test("collectUnits drains from the mark", () => {
		const mark = markCollection();
		bench("drained", () => 1);
		expect(collectUnits(mark)).toHaveLength(1);
		expect(collectUnits(mark)).toHaveLength(0);
	});
});

describe("fixture", () => {
	test("resolves once, cleans up in reverse order", async () => {
		const order: string[] = [];
		const slow = fixture("slow", async ({ onCleanup }) => {
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			onCleanup(() => {
				order.push("slow");
			});

			return "slow-value";
		});
		const fast = fixture("fast", ({ onCleanup }) => {
			onCleanup(() => {
				order.push("fast");
			});

			return "fast-value";
		});

		const mark = markCollection();
		collectUnits(mark);
		expect(await Promise.all([fast(), slow(), fast()])).toEqual(["fast-value", "slow-value", "fast-value"]);
		await cleanupFixtures();
		expect(order).toEqual(["slow", "fast"]);
	});

	test("runs earlier cleanups when a later setup throws", async () => {
		const cleanups: string[] = [];
		const good = fixture("good", ({ onCleanup }) => {
			onCleanup(() => {
				cleanups.push("good");
			});

			return 1;
		});
		const bad = fixture("bad", () => {
			throw new Error("setup boom");
		});

		const mark = markCollection();
		collectUnits(mark);
		await good();
		let error: unknown;
		try {
			await bad();
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		await cleanupFixtures();
		expect(cleanups).toEqual(["good"]);
	});
});

describe("Recorder", () => {
	test("records latencies and errors", () => {
		const recorder = new Recorder();
		recorder.record("op", 10, true);
		recorder.record("op", 20, false);
		recorder.recordError("dead");
		expect(recorder.summary()).toEqual([
			{ label: "op", count: 2, errors: 1, p50: 10, p95: 20, p99: 20, max: 20 },
			{ label: "dead", count: 0, errors: 1, p50: 0, p95: 0, p99: 0, max: 0 },
		]);
		const serialized = recorder.serialize();
		expect(serialized.op?.errors).toBe(1);
		expect(serialized.op?.meanMs).toBe(15);
	});
});

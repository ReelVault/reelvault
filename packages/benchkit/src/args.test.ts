import { describe, expect, spyOn, test } from "bun:test";
import { parseBenchmarkArgs, suiteArgs } from "./args.parser";

function withArgv(argv: string[], run: () => void): void {
	const original = process.argv;
	process.argv = ["bun", "script.ts", ...argv];
	try {
		run();
	} finally {
		process.argv = original;
	}
}

describe("parseBenchmarkArgs", () => {
	test("applies defaults with no arguments", () => {
		withArgv([], () => {
			const args = parseBenchmarkArgs();
			expect(args.targets).toEqual([]);
			expect(args.concurrency).toEqual([1, 10, 50, 100]);
			expect(args.durationMs).toBe(10_000);
			expect(args.iterations).toBe(100);
			expect(args.flags).toEqual({});
			expect(args.help).toBe(false);
		});
	});

	test("every bare token is a suite, in the order given", () => {
		withArgv(["matching", "--iterations", "7", "database"], () => {
			const args = parseBenchmarkArgs();
			expect(args.targets).toEqual(["matching", "database"]);
			expect(args.iterations).toBe(7);
		});
	});

	test("inline values and concurrency lists", () => {
		withArgv(["--duration=500", "--concurrency=2,4"], () => {
			const args = parseBenchmarkArgs();
			expect(args.durationMs).toBe(500);
			expect(args.concurrency).toEqual([2, 4]);
		});
	});

	test("json and strict are first-class flags", () => {
		withArgv(["matching", "--strict", "--json=/tmp/out.json"], () => {
			const args = parseBenchmarkArgs();
			expect(args.targets).toEqual(["matching"]);
			expect(args.strict).toBe(true);
			expect(args.json).toBe("/tmp/out.json");
			expect(args.help).toBe(false);
		});
	});

	test("bare --json and --profile never swallow the suite after them", () => {
		withArgv(["--json", "matching", "--profile", "http"], () => {
			const args = parseBenchmarkArgs();
			expect(args.json).toBe(true);
			expect(args.profile).toBe(true);
			expect(args.targets).toEqual(["matching", "http"]);
		});
	});

	test("extra flags are recorded, not flagged unknown", () => {
		withArgv(["query-plan", "--sieve=heavy", "--loose"], () => {
			const args = parseBenchmarkArgs(new Set(["sieve", "loose"]));
			expect(args.targets).toEqual(["query-plan"]);
			expect(args.flags.sieve).toBe("heavy");
			expect(args.flags.loose).toBe(true);
			expect(args.help).toBe(false);
		});
	});

	test("unknown flags warn and request help", () => {
		const warnings: string[] = [];
		const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			withArgv(["--nope"], () => {
				const args = parseBenchmarkArgs();
				expect(args.help).toBe(true);
			});
		} finally {
			spy.mockRestore();
		}
		expect(warnings).toEqual(["Unknown flag: --nope"]);
	});
});

describe("suiteArgs", () => {
	test("memoizes the first parse for the whole process", () => {
		const a = suiteArgs();
		const b = suiteArgs();
		expect(b).toBe(a);
	});
});

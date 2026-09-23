import { afterEach, describe, expect, test } from "bun:test";
import { parseBenchmarkArgs, suiteArgs } from "./args";

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
	afterEach(() => {
		process.exitCode = undefined;
	});

	test("applies defaults with no arguments", () => {
		withArgv([], () => {
			const args = parseBenchmarkArgs();
			expect(args.target).toBeUndefined();
			expect(args.concurrency).toEqual([1, 10, 50, 100]);
			expect(args.durationMs).toBe(10_000);
			expect(args.iterations).toBe(100);
			expect(args.flags).toEqual({});
			expect(args.help).toBe(false);
		});
	});

	test("first bare token is the target", () => {
		withArgv(["matching", "--iterations", "7"], () => {
			const args = parseBenchmarkArgs();
			expect(args.target).toBe("matching");
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
			expect(args.target).toBe("matching");
			expect(args.strict).toBe(true);
			expect(args.json).toBe("/tmp/out.json");
			expect(args.help).toBe(false);
		});
	});

	test("bare --json means the default path and never swallows the target", () => {
		withArgv(["--strict", "matching"], () => {
			const args = parseBenchmarkArgs();
			expect(args.strict).toBe(true);
			expect(args.target).toBe("matching");
		});
	});

	test("extra flags are recorded, not flagged unknown", () => {
		withArgv(["query-plan", "--sieve=heavy", "--loose"], () => {
			const args = parseBenchmarkArgs(new Set(["sieve", "loose"]));
			expect(args.target).toBe("query-plan");
			expect(args.flags.sieve).toBe("heavy");
			expect(args.flags.loose).toBe(true);
			expect(args.help).toBe(false);
		});
	});

	test("unknown flags warn and request help", () => {
		withArgv(["--nope"], () => {
			const args = parseBenchmarkArgs();
			expect(args.help).toBe(true);
		});
	});
});

describe("suiteArgs", () => {
	test("memoizes the first parse for the whole process", () => {
		const a = suiteArgs();
		const b = suiteArgs();
		expect(b).toBe(a);
	});
});

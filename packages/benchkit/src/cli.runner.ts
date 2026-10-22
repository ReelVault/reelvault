import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BenchmarkArgs, suiteArgs } from "./args.parser";
import { runDiscovery } from "./bench.runner";

/** Set for a `--profile` run; processes the suites spawn write their profiles under it (`profilerFlags`). */
export const PROFILE_DIR_ENV = "BENCHKIT_PROFILE_DIR";

export interface BenchmarkCliOptions {
	/** Directory holding the `*.bench.ts` suites. */
	suitesDir: string;
	/** Command shown in the usage line: `bun run <command>`. */
	command: string;
	/** Where `--json`, the baselines and the profiles go (default `benchmark-results`). */
	resultsDir?: string | undefined;
	/** Flags the project adds to benchkit's own; suites read them from `args.flags`. */
	extraFlags?: ReadonlySet<string> | undefined;
	/** Usage lines for those flags. */
	extraUsage?: string | undefined;
	/**
	 * Runs after the flags are parsed and before any suite is imported: isolate the environment
	 * (temporary data directories, production mode), apply simulated hardware, and so on.
	 */
	prepare?: ((args: BenchmarkArgs) => void | Promise<void>) | undefined;
}

function profilerFlagsInto(dir: string): string[] {
	return ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${dir}`, "--heap-prof", "--heap-prof-md", `--heap-prof-dir=${dir}`];
}

/**
 * Bun's CPU and heap profiler flags for a process a suite spawns, writing into `<profile dir>/<label>`;
 * empty outside a `--profile` run. They go before the script: `[bun, ...profilerFlags("server"), "app.ts"]`.
 * The profiles are written when the process exits, a SIGTERM shutdown included.
 */
export function profilerFlags(label: string): string[] {
	const root = process.env[PROFILE_DIR_ENV];
	if (!root) return [];

	const dir = join(root, `${label}-${Date.now()}`);
	console.log(`[benchkit] profiling ${label} → ${dir}`);

	return profilerFlagsInto(dir);
}

/**
 * `--profile`: runs the same command again under Bun's CPU and heap profilers, into one directory per
 * run — this process's profiles (in-process suites) at its root, spawned processes in subfolders.
 */
async function rerunProfiled(resultsDir: string): Promise<never> {
	const dir = resolve(resultsDir, "profiles", new Date().toISOString().replaceAll(/[:.]/g, "-"));
	mkdirSync(dir, { recursive: true });
	console.log(`[benchkit] profiling → ${dir} (timings are slower under the profiler)`);
	const profiled = Bun.spawn({
		cmd: [process.execPath, ...profilerFlagsInto(dir), ...process.argv.slice(1)],
		env: { ...process.env, [PROFILE_DIR_ENV]: dir },
		stdio: ["inherit", "inherit", "inherit"],
	});
	const exitCode = await profiled.exited;
	console.log(`[benchkit] profiles written to ${dir}`);
	process.exit(exitCode);
}

/** `--flag` alone means the default path, `--flag=path` that path. */
function outputPath(value: string | boolean | undefined, defaultPath: string): string | undefined {
	if (value === true) return defaultPath;

	return typeof value === "string" ? value : undefined;
}

/**
 * The whole benchmark command line in one call: parses the flags, re-runs itself under the profiler
 * for `--profile`, runs `prepare`, then lists or runs the suites in `suitesDir`.
 *
 *   await runBenchmarkCli({ suitesDir: join(import.meta.dir, "benchmarks"), command: "benchmark" });
 */
export async function runBenchmarkCli(options: BenchmarkCliOptions): Promise<void> {
	const resultsDir = options.resultsDir ?? "benchmark-results";
	const args = suiteArgs(options.extraFlags);
	if (args.profile && !process.env[PROFILE_DIR_ENV]) await rerunProfiled(resultsDir);

	await options.prepare?.(args);

	const files = readdirSync(options.suitesDir)
		.filter((file) => file.endsWith(".bench.ts"))
		.toSorted()
		.map((file) => join(options.suitesDir, file));
	const baselinePath = join(resultsDir, "baseline.json");

	await runDiscovery({
		files,
		command: options.command,
		extraUsage: options.extraUsage,
		targets: args.targets,
		help: args.help,
		only: args.only,
		jsonPath: outputPath(args.json, join(resultsDir, "benchkit-latest.json")),
		saveBaseline: outputPath(args.saveBaseline, baselinePath),
		compareBaseline: outputPath(args.compareBaseline, baselinePath),
		strict: args.strict,
	});
}

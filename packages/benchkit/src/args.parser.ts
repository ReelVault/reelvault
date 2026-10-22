export interface BenchmarkArgs {
	/** Suites to run, in order (`bun run benchmark http database`); `all` runs every suite. */
	targets: string[];
	/** Base URL of an already-running server. When set, no server is spawned. */
	baseUrl?: string;
	/** Comma-separated concurrency levels, e.g. "1,10,50,100". */
	concurrency: number[];
	/** Duration of each load scenario in ms. */
	durationMs: number;
	/** Warmup duration before measurements start, in ms. */
	warmupMs: number;
	/** Iterations for micro-benchmarks. */
	iterations: number;
	/** Rows seeded into the benchmark database. */
	rows: number;
	/** Upload payload size in MB. */
	sizeMb: number;
	/** Only run load scenarios whose name contains this substring. */
	scenario?: string | undefined;
	/** Keep the spawned server alive after the run (for debugging). */
	keepServer: boolean;
	/** Send `Cache-Control: no-cache` so responses bypass the server-side body cache (cold path). */
	noCache: boolean;
	/** Run with in-flight request/load coalescing off (every concurrent request does its own work). */
	noDedup: boolean;
	/** Write CPU and heap profiles of the benchmark process and every spawned server. */
	profile: boolean;
	/** Write machine-readable results here; `true` means the runner's default path (`--json[=path]`). */
	json?: string | boolean | undefined;
	/** Only run units whose name matches this regex (`--only`, case-insensitive). */
	only?: string | undefined;
	/** Save raw bench samples as a baseline; `true` means the default path (`--save-baseline[=path]`). */
	saveBaseline?: string | boolean | undefined;
	/** Compare against a saved baseline and print verdicts (`--compare-baseline[=path]`). */
	compareBaseline?: string | boolean | undefined;
	/** Fail the run when a task/compare reports a failure or a unit regressed (`--strict`). */
	strict: boolean;
	/** Extra flags accepted via `extraFlags`, recorded as `true` (no value) or their string value. */
	flags: Record<string, string | boolean>;
	/** Show usage. */
	help: boolean;
}

export const DEFAULT_CONCURRENCY_STEPS = [1, 10, 50, 100];

export const DEFAULT_DURATION_MS = 10_000;

export const DEFAULT_WARMUP_MS = 2_000;

export const DEFAULT_ITERATIONS = 100;

export const DEFAULT_SEED_ROWS = 5_000;

export const DEFAULT_UPLOAD_SIZE_MB = 25;

/** Flags that take no value unless given inline as `--flag=value`; they never consume the next token. */
const BOOLEAN_FLAGS = new Set([
	"help",
	"strict",
	"json",
	"save-baseline",
	"compare-baseline",
	"keep-server",
	"no-cache",
	"no-dedup",
	"profile",
]);
const TRAILING_SLASH_REGEX = /\/$/;

export function printUsage(scriptName: string, extra = ""): void {
	console.log(`Usage: bun run ${scriptName} <suite...> [flags]
  suite...               one or more suites, run in order ("all" runs every suite)
  --only <regex>         only run units (bench/compare/task) whose name matches
  --scenario <substr>    only run load scenarios whose name contains this substring
  --rows <n>             rows the suites seed (default: ${DEFAULT_SEED_ROWS})
  --concurrency <list>   comma-separated concurrency levels (default: ${DEFAULT_CONCURRENCY_STEPS.join(",")})
  --duration <ms>        per-scenario duration (default: ${DEFAULT_DURATION_MS})
  --warmup <ms>          warmup duration (default: ${DEFAULT_WARMUP_MS})
  --iterations <n>       micro-benchmark iterations (default: ${DEFAULT_ITERATIONS})
  --size-mb <n>          upload payload size in MB (default: ${DEFAULT_UPLOAD_SIZE_MB})
  --url <url>            target an already-running server (default: spawn a managed one)
  --keep-server          leave the spawned server running after the run
  --no-cache             ask the suites for the cold path (no response caches)
  --no-dedup             ask the suites to turn off request coalescing (worst-case concurrent work)
  --profile              write CPU and heap profiles (.cpuprofile + .md) of the run and the processes it spawns
  --save-baseline[=path] save raw samples and task metrics (default: benchmark-results/baseline.json)
  --compare-baseline[=path]
                         compare against a baseline: faster / slower / unchanged / noisy per unit
  --json[=path]          write machine-readable results (default: benchmark-results/benchkit-latest.json)
  --strict               exit non-zero when a unit reports a failure or regressed vs the baseline${extra}`);
}

function parseConcurrency(value: string): number[] {
	const parsed = value
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((n) => Number.isInteger(n) && n > 0);

	return parsed.length > 0 ? parsed : DEFAULT_CONCURRENCY_STEPS;
}

function positiveInteger(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? "", 10);

	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Applies one flag; returns false for a flag the parser does not know. */
function applyFlag(args: BenchmarkArgs, key: string, value: string | undefined): boolean {
	switch (key) {
		case "help":
			args.help = true;
			break;
		case "strict":
			args.strict = true;
			break;
		case "keep-server":
			args.keepServer = true;
			break;
		case "no-cache":
			args.noCache = true;
			break;
		case "no-dedup":
			args.noDedup = true;
			break;
		case "profile":
			args.profile = true;
			break;
		case "json":
			args.json = value ?? true;
			break;
		case "save-baseline":
			args.saveBaseline = value ?? true;
			break;
		case "compare-baseline":
			args.compareBaseline = value ?? true;
			break;
		case "url":
			if (value) args.baseUrl = value.replace(TRAILING_SLASH_REGEX, "");
			break;
		case "only":
			args.only = value;
			break;
		case "scenario":
			args.scenario = value;
			break;
		case "concurrency":
			if (value) args.concurrency = parseConcurrency(value);
			break;
		case "duration":
			args.durationMs = positiveInteger(value) ?? args.durationMs;
			break;
		case "warmup":
			args.warmupMs = positiveInteger(value) ?? args.warmupMs;
			break;
		case "iterations":
			args.iterations = positiveInteger(value) ?? args.iterations;
			break;
		case "rows":
			args.rows = positiveInteger(value) ?? args.rows;
			break;
		case "size-mb":
			args.sizeMb = positiveInteger(value) ?? args.sizeMb;
			break;
		default:
			return false;
	}

	return true;
}

export function parseBenchmarkArgs(extraFlags: ReadonlySet<string> = new Set()): BenchmarkArgs {
	const args: BenchmarkArgs = {
		targets: [],
		concurrency: DEFAULT_CONCURRENCY_STEPS,
		durationMs: DEFAULT_DURATION_MS,
		warmupMs: DEFAULT_WARMUP_MS,
		iterations: DEFAULT_ITERATIONS,
		rows: DEFAULT_SEED_ROWS,
		sizeMb: DEFAULT_UPLOAD_SIZE_MB,
		keepServer: false,
		noCache: false,
		noDedup: false,
		profile: false,
		strict: false,
		flags: {},
		help: false,
	};

	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (!token.startsWith("--")) {
			if (token) args.targets.push(token);
			continue;
		}

		const [key = "", inlineValue] = token.slice(2).split("=", 2);
		const value = inlineValue ?? (BOOLEAN_FLAGS.has(key) ? undefined : argv[++index]);
		if (applyFlag(args, key, value)) continue;

		if (extraFlags.has(key)) {
			args.flags[key] = value ?? true;
			continue;
		}

		console.warn(`Unknown flag: --${key}`);
		args.help = true;
	}

	return args;
}

let suiteArgsCache: BenchmarkArgs | undefined;

/**
 * Process-wide memoized args: the bootstrap and every bench file share ONE
 * parse, so per-file re-parsing cannot double-warn or disagree about help.
 */
export function suiteArgs(extraFlags?: ReadonlySet<string>): BenchmarkArgs {
	suiteArgsCache ??= parseBenchmarkArgs(extraFlags);

	return suiteArgsCache;
}

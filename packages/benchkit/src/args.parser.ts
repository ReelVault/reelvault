export interface BenchmarkArgs {
	/** Benchmark target to run (e.g. "http", "streaming", "upload", "database", "workers", "scanner", "ffmpeg", "all"). */
	target?: string;
	/** Base URL of an already-running server. When set, no server is spawned. */
	baseUrl?: string;
	/** Comma-separated concurrency levels, e.g. "1,10,50,100". */
	concurrency: number[];
	/** Duration of each HTTP scenario in ms. */
	durationMs: number;
	/** Warmup duration before measurements start, in ms. */
	warmupMs: number;
	/** Iterations for micro-benchmarks. */
	iterations: number;
	/** Rows seeded into the benchmark database. */
	rows: number;
	/** Upload payload size in MB. */
	sizeMb: number;
	/** Only run HTTP scenarios whose name contains this substring. */
	scenario?: string | undefined;
	/** Keep the spawned server alive after the run (for debugging). */
	keepServer: boolean;
	/** Send `Cache-Control: no-cache` so responses bypass the server-side body cache (cold path). */
	noCache: boolean;
	/** Write machine-readable results here; `true` means the runner's default path (`--json[=path]`). */
	json?: string | boolean | undefined;
	/** Only run units whose name matches this regex (`--only`, case-insensitive). */
	only?: string | undefined;
	/** Save raw bench samples as a baseline; `true` means the default path (`--save-baseline[=path]`). */
	saveBaseline?: string | boolean | undefined;
	/** Compare against a saved baseline and print verdicts (`--compare-baseline[=path]`). */
	compareBaseline?: string | boolean | undefined;
	/** Fail the run when a task/compare reports a failure (`--strict`). */
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

const FLAG_NAMES = new Set(["url", "concurrency", "duration", "warmup", "iterations", "rows", "size-mb", "target"]);
/** Flags that take no value unless given inline as `--flag=value`. */
const BOOLEAN_FLAGS = new Set(["strict", "json", "save-baseline", "compare-baseline", "keep-server", "no-cache"]);
const TRAILING_SLASH_REGEX = /\/$/;

export function printUsage(scriptName: string, extra = ""): void {
	console.log(`Usage: bun run ${scriptName} [target] [flags]
  target                 benchmark target (see the suite list below; "all" runs everything)
  --url <url>            target an already-running server (default: spawn a managed one)
  --concurrency <list>   comma-separated concurrency levels (default: ${DEFAULT_CONCURRENCY_STEPS.join(",")})
  --duration <ms>        per-scenario duration (default: ${DEFAULT_DURATION_MS})
  --warmup <ms>          warmup duration (default: ${DEFAULT_WARMUP_MS})
  --iterations <n>       micro-benchmark iterations (default: ${DEFAULT_ITERATIONS})
  --rows <n>             seeded catalog rows (default: ${DEFAULT_SEED_ROWS})
  --size-mb <n>          upload payload size in MB (default: ${DEFAULT_UPLOAD_SIZE_MB})
  --scenario <substr>    only run HTTP scenarios whose name contains this substring
  --only <regex>         only run units (bench/compare/task) whose name matches this regex
  --save-baseline[=path] save raw bench samples as a baseline (default: benchmark-results/baseline.json)
  --compare-baseline[=path]
                         compare against a baseline and print verdicts; with --strict a "slower" verdict fails
  --no-cache             bypass the server-side response body cache (cold path)
  --json[=path]          write machine-readable results (default path: benchmark-results/benchkit-latest.json)
  --strict               exit non-zero when an audit/comparison unit reports a failure${extra}`);
}

function parseConcurrency(value: string): number[] {
	const parsed = value
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((n) => Number.isInteger(n) && n > 0);

	return parsed.length > 0 ? parsed : DEFAULT_CONCURRENCY_STEPS;
}

function applyNumericFlag(args: BenchmarkArgs, key: string, value: string): void {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return;

	if (key === "duration") {
		args.durationMs = parsed;
	} else if (key === "warmup") {
		args.warmupMs = parsed;
	} else if (key === "iterations") {
		args.iterations = parsed;
	} else if (key === "rows") {
		args.rows = parsed;
	} else if (key === "size-mb") {
		args.sizeMb = parsed;
	}
}

function applyFlag(args: BenchmarkArgs, key: string, value: string | undefined, extraFlags: ReadonlySet<string>): void {
	if (key === "help") {
		args.help = true;

		return;
	}

	if (key === "target" && value) {
		args.target = value;

		return;
	}

	if (key === "url" && value) {
		args.baseUrl = value.replace(TRAILING_SLASH_REGEX, "");

		return;
	}

	if (key === "scenario" && value) {
		args.scenario = value;

		return;
	}

	if (key === "keep-server") {
		args.keepServer = true;

		return;
	}

	if (key === "no-cache") {
		args.noCache = true;

		return;
	}

	if (key === "json") {
		args.json = value ?? true;

		return;
	}

	if (key === "strict") {
		args.strict = true;

		return;
	}

	if (key === "save-baseline") {
		args.saveBaseline = value ?? true;

		return;
	}

	if (key === "compare-baseline") {
		args.compareBaseline = value ?? true;

		return;
	}

	if (key === "only" && value) {
		args.only = value;

		return;
	}

	if (key === "concurrency" && value) {
		args.concurrency = parseConcurrency(value);

		return;
	}

	if (FLAG_NAMES.has(key) && value) {
		applyNumericFlag(args, key, value);

		return;
	}

	if (extraFlags.has(key)) {
		args.flags[key] = value ?? true;

		return;
	}

	console.warn(`Unknown flag: --${key}`);
	args.help = true;
}

export function parseBenchmarkArgs(extraFlags: ReadonlySet<string> = new Set()): BenchmarkArgs {
	const args: BenchmarkArgs = {
		concurrency: DEFAULT_CONCURRENCY_STEPS,
		durationMs: DEFAULT_DURATION_MS,
		warmupMs: DEFAULT_WARMUP_MS,
		iterations: DEFAULT_ITERATIONS,
		rows: DEFAULT_SEED_ROWS,
		sizeMb: DEFAULT_UPLOAD_SIZE_MB,
		keepServer: false,
		noCache: false,
		strict: false,
		flags: {},
		help: false,
	};

	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token) continue;

		if (!token.startsWith("--")) {
			args.target ??= token;
			continue;
		}

		const [rawKey, inlineValue] = token.slice(2).split("=", 2);
		const key = rawKey ?? "";
		if (BOOLEAN_FLAGS.has(key) && inlineValue === undefined) {
			// Boolean flags never consume the next token (it may be an unrelated
			// positional or flag); `--flag=value` is the only valued form.
			applyFlag(args, key, undefined, extraFlags);
			continue;
		}

		const value = inlineValue ?? argv[++index];
		applyFlag(args, key, value, extraFlags);
	}

	return args;
}

let suiteArgsCache: BenchmarkArgs | undefined;

/**
 * Process-wide memoized args: the bootstrap and every bench file share ONE
 * parse, so per-file re-parsing cannot double-warn or disagree about help.
 */
export function suiteArgs(): BenchmarkArgs {
	suiteArgsCache ??= parseBenchmarkArgs();

	return suiteArgsCache;
}

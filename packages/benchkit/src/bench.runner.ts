import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { gc } from "bun";
import { printUsage } from "./args.parser";
import { type BaselineComparison, type BaselineEntry, type BaselineFile, compareWithBaseline, type Verdict } from "./baseline.utils";
import {
	type BenchUnit,
	type CompareUnit,
	cleanupFixtures,
	collectUnits,
	markCollection,
	type TaskUnit,
	type Unit,
} from "./bench.registry";
import { type CompareVariantResult, compareVariants, printAbResult } from "./compare.utils";
import { type LatencyStats, summarizeLatencies } from "./latency.utils";
import { metricsOf } from "./metrics.utils";
import { type MicroBenchmarkResult, measure, measureAsync, printMicroResults } from "./micro.utils";
import { printTable } from "./report.utils";

export interface RunnerJson {
	schema: "benchkit/v1";
	generatedAt: string;
	files: Array<{ file: string; description: string; results: UnitJson[] }>;
}

type UnitJson = BenchJson | CompareJson | TaskJson;

interface BenchJson {
	kind: "bench";
	name: string;
	group?: string | undefined;
	stats: LatencyStats;
	rows?: number;
	verdict?: Verdict | undefined;
}

interface CompareJson {
	kind: "compare";
	name: string;
	winner: string;
	equalOk: boolean;
	variants: CompareVariantResult[];
}

interface TaskJson {
	kind: "task";
	name: string;
	ok: boolean;
	data?: unknown;
}

/** One suite file: its stem (`http` for `http.bench.ts`), path and `meta.description`. */
export interface SuiteFile {
	stem: string;
	path: string;
	description: string;
}

export interface DiscoveryOptions {
	/** Absolute paths of the *.bench.ts files (the caller globs them). */
	files: readonly string[];
	/** Command name for the usage line (e.g. "benchmark"). */
	command: string;
	/** Usage lines for the project's own flags. */
	extraUsage?: string | undefined;
	/** Suites to run, in order; `all` runs every file. Empty prints the usage. */
	targets: readonly string[];
	help?: boolean | undefined;
	/** Unit-name regex filter (`--only`); only matching units run. */
	only?: string | undefined;
	/** Write raw bench samples as a baseline (`--save-baseline[=path]`). */
	saveBaseline?: string | undefined;
	/** Compare against a saved baseline and print verdicts (`--compare-baseline[=path]`). */
	compareBaseline?: string | undefined;
	jsonPath?: string | undefined;
	strict?: boolean | undefined;
}

const STEM_SUFFIX_REGEX = /\.bench\.ts$/;
/** The `description: "..."` of a suite's `meta` export, read from the source so listing imports nothing. */
const DESCRIPTION_REGEX = /description:\s*"((?:[^"\\]|\\.)*)"/;

/** Suite stem from a bench file path (`.../http.bench.ts` → `http`). */
function stemOf(file: string): string {
	return basename(file).replace(STEM_SUFFIX_REGEX, "");
}

function suiteFile(path: string): SuiteFile {
	const description = DESCRIPTION_REGEX.exec(readFileSync(path, "utf8"))?.[1] ?? "";

	return { stem: stemOf(path), path, description };
}

/** Compiles the `--only` unit-name filter; case-insensitive, undefined = no filter. */
export function compileOnlyFilter(pattern: string | undefined): RegExp | undefined {
	if (pattern === undefined || pattern.length === 0) return undefined;

	return new RegExp(pattern, "i");
}

/**
 * The suites the targets name, in the order given and without repeats; `all` expands to every suite.
 * Returns the unknown names when there are any.
 */
export function selectSuites(suites: readonly SuiteFile[], targets: readonly string[]): { selected: SuiteFile[]; unknown: string[] } {
	const selected: SuiteFile[] = [];
	const unknown: string[] = [];
	for (const target of targets) {
		const matches = target === "all" ? suites : suites.filter((suite) => suite.stem === target);
		if (matches.length === 0) unknown.push(target);
		for (const suite of matches) {
			if (!selected.includes(suite)) selected.push(suite);
		}
	}

	return { selected, unknown };
}

function printRunnerUsage(options: DiscoveryOptions, suites: readonly SuiteFile[]): void {
	const width = Math.max(...suites.map((suite) => suite.stem.length), 3);
	const lines = suites.map((suite) => `  ${suite.stem.padEnd(width)}  ${suite.description}`);
	printUsage(
		options.command,
		`${options.extraUsage ? `\n${options.extraUsage}` : ""}\n\nSuites:\n${lines.join("\n")}\n  ${"all".padEnd(width)}  every suite above, in order\n`,
	);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") && value !== null && "then" in value && typeof value.then === "function"
	);
}

/** Narrows a task body's return value into ok + optional serializable data. */
function asTaskOutcome(value: unknown): { ok: boolean; data?: unknown } {
	if (typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean") {
		return "data" in value ? { ok: value.ok, data: value.data } : { ok: value.ok };
	}

	return { ok: true };
}

/**
 * Executes units in registration order. Bench units buffer per group and
 * flush as one table; compare units and tasks print as they run. Returns the
 * number of units that reported a failure.
 */
async function executeUnits(units: readonly Unit[], json: UnitJson[], baselineOut: BaselineEntry[], fileStem: string): Promise<number> {
	let failures = 0;
	let pendingGroup = "";
	let pending: MicroBenchmarkResult[] = [];
	const flush = (): void => {
		if (pending.length === 0) return;

		printMicroResults(pending, pendingGroup || undefined);
		pending = [];
	};

	for (const unit of units) {
		if (unit.kind !== "bench" || unit.group !== pendingGroup) flush();

		switch (unit.kind) {
			case "bench":
				pendingGroup = unit.group;
				pending.push(await runBenchUnit(unit, json, baselineOut, fileStem));
				break;
			case "compare":
				if (!runCompareUnit(unit, json)) failures++;
				break;
			case "task":
				if (!(await runTaskUnit(unit, json, baselineOut, fileStem))) failures++;
				break;
			default:
				break;
		}
	}

	flush();

	return failures;
}

async function runBenchUnit(
	unit: BenchUnit,
	json: UnitJson[],
	baselineOut: BaselineEntry[],
	fileStem: string,
): Promise<MicroBenchmarkResult> {
	// The first call tells a sync unit from an async one and yields the row count of a query.
	let produced = unit.fn({ iteration: 0 });
	const isAsync = isThenable(produced);
	if (isAsync) produced = await produced;

	const measured = isAsync
		? await measureAsync(unit.name, (iteration) => Promise.resolve(unit.fn({ iteration })), unit.options)
		: measure(unit.name, (iteration) => unit.fn({ iteration }), unit.options);
	const entry: MicroBenchmarkResult = Array.isArray(produced) ? { ...measured, rows: produced.length } : measured;
	const stats = summarizeLatencies(entry.timesMs);
	json.push({
		kind: "bench",
		name: entry.name,
		...(unit.group.length > 0 ? { group: unit.group } : {}),
		stats,
		...(entry.rows === undefined ? {} : { rows: entry.rows }),
	});
	baselineOut.push({ kind: "bench", file: fileStem, name: entry.name, samples: entry.timesMs, p50Ms: stats.p50Ms });

	return entry;
}

/** Returns whether the A/B comparison passed its equality check. */
function runCompareUnit(unit: CompareUnit, json: UnitJson[]): boolean {
	const outcome = compareVariants(unit.name, unit.variants, { ...unit.options, equal: unit.equal });
	printAbResult(outcome);
	json.push({ kind: "compare", name: unit.name, winner: outcome.winner, equalOk: outcome.equalOk, variants: outcome.variants });

	return outcome.equalOk;
}

/** Returns whether the task reported success. */
async function runTaskUnit(unit: TaskUnit, json: UnitJson[], baselineOut: BaselineEntry[], fileStem: string): Promise<boolean> {
	const outcome = asTaskOutcome(await unit.fn());
	json.push({ kind: "task", name: unit.name, ok: outcome.ok, ...(outcome.data === undefined ? {} : { data: outcome.data }) });

	// A task that returns `data.metrics` opts into baseline comparison.
	const metrics = metricsOf(outcome.data);
	if (metrics) baselineOut.push({ kind: "task", file: fileStem, name: unit.name, metrics });

	if (!outcome.ok) console.warn(`[benchkit] task "${unit.name}" reported failure`);

	return outcome.ok;
}

interface SuiteRun {
	json: RunnerJson["files"][number];
	baseline: BaselineEntry[];
	failures: number;
	units: number;
}

async function runSuite(suite: SuiteFile, onlyRe: RegExp | undefined): Promise<SuiteRun> {
	const mark = markCollection();
	await import(suite.path);
	const collected = collectUnits(mark);
	const units = onlyRe ? collected.filter((unit) => onlyRe.test(unit.name)) : collected;
	console.log(`[benchkit] running suite "${suite.stem}": ${suite.description}\n`);

	const json: RunnerJson["files"][number] = { file: basename(suite.path), description: suite.description, results: [] };
	const baseline: BaselineEntry[] = [];
	try {
		const failures = await executeUnits(units, json.results, baseline, suite.stem);

		return { json, baseline, failures, units: units.length };
	} finally {
		await cleanupFixtures();
		gc(true);
	}
}

/** Discovers, imports and runs the selected *.bench.ts files in order, gc-ing between them. */
export async function runDiscovery(options: DiscoveryOptions): Promise<void> {
	const suites = options.files.map((file) => suiteFile(file));
	if (options.help || options.targets.length === 0) {
		printRunnerUsage(options, suites);

		return;
	}

	const { selected, unknown } = selectSuites(suites, options.targets);
	if (unknown.length > 0) {
		console.error(`Unknown benchmark suite: ${unknown.map((name) => `"${name}"`).join(", ")}\n`);
		printRunnerUsage(options, suites);
		process.exitCode = 1;

		return;
	}

	let onlyRe: RegExp | undefined;
	try {
		onlyRe = compileOnlyFilter(options.only);
	} catch {
		console.error(`[benchkit] invalid --only regex: ${options.only ?? ""}`);
		process.exitCode = 1;

		return;
	}

	const artifact: RunnerJson = { schema: "benchkit/v1", generatedAt: new Date().toISOString(), files: [] };
	const baselineEntries: BaselineEntry[] = [];
	let failures = 0;
	let matchedUnits = 0;
	try {
		for (const suite of selected) {
			const run = await runSuite(suite, onlyRe);
			artifact.files.push(run.json);
			baselineEntries.push(...run.baseline);
			failures += run.failures;
			matchedUnits += run.units;
		}
	} catch (error) {
		console.error("Benchmark failed:", error);
		process.exitCode = 1;

		return;
	}

	let regressions = 0;
	if (options.compareBaseline) {
		const baseline = await readBaselineFile(options.compareBaseline);
		const { comparisons, missingInBaseline } = compareWithBaseline(baselineEntries, baseline.entries);
		printBaselineComparison(comparisons, options.compareBaseline, missingInBaseline);
		applyVerdicts(artifact, comparisons);
		regressions = comparisons.filter((comparison) => comparison.verdict === "slower").length;
	}

	if (options.saveBaseline) await saveBaseline(options.saveBaseline, baselineEntries);

	if (options.jsonPath) {
		await mkdir(dirname(options.jsonPath), { recursive: true });
		await writeFile(options.jsonPath, `${JSON.stringify(artifact, null, "\t")}\n`);
		console.log(`\n[benchkit] JSON results written to ${options.jsonPath}`);
	}

	if (onlyRe && matchedUnits === 0) {
		console.error(`\n[benchkit] --only "${options.only ?? ""}" matched no units in ${selected.length} suite(s).`);
		process.exitCode = 1;
	}

	if (options.strict && failures > 0) {
		console.error(`\n[benchkit] strict mode: failing because ${failures} unit(s) reported failure.`);
		process.exitCode = 1;
	}

	if (options.strict && regressions > 0) {
		console.error(`\n[benchkit] strict mode: failing because ${regressions} unit(s) regressed vs baseline.`);
		process.exitCode = 1;
	}
}

async function saveBaseline(path: string, entries: BaselineEntry[]): Promise<void> {
	const baselineFile: BaselineFile = { schema: "benchkit-baseline/v1", generatedAt: new Date().toISOString(), entries };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(baselineFile, null, "\t")}\n`);
	const benchCount = entries.filter((entry) => entry.kind === "bench").length;
	const taskCount = entries.length - benchCount;
	console.log(
		`\n[benchkit] baseline (${benchCount} bench units${taskCount > 0 ? `, ${taskCount} task metric sets` : ""}) saved to ${path}`,
	);
}

function isBaselineFile(value: unknown): value is BaselineFile {
	if (typeof value !== "object" || value === null) return false;

	if (!("schema" in value) || value.schema !== "benchkit-baseline/v1") return false;

	return "entries" in value && Array.isArray(value.entries);
}

async function readBaselineFile(path: string): Promise<BaselineFile> {
	const raw: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!isBaselineFile(raw)) throw new Error(`Invalid baseline file: ${path}`);

	return raw;
}

function printBaselineComparison(comparisons: readonly BaselineComparison[], path: string, missingInBaseline: number): void {
	printTable(
		`Baseline comparison vs ${path}`,
		["unit", "verdict", "delta p50", "samples"],
		comparisons.map((comparison) => [
			`${comparison.file}: ${comparison.name}`,
			comparison.verdict,
			`${comparison.deltaPercent >= 0 ? "+" : ""}${comparison.deltaPercent.toFixed(1)}%`,
			String(comparison.samples),
		]),
	);
	const counts: Record<Verdict, number> = { faster: 0, slower: 0, unchanged: 0, noisy: 0 };
	for (const comparison of comparisons) counts[comparison.verdict]++;
	console.log(
		`[benchkit] verdicts: ${counts.faster} faster, ${counts.slower} slower, ${counts.unchanged} unchanged, ${counts.noisy} noisy${missingInBaseline > 0 ? `, ${missingInBaseline} not in baseline` : ""}`,
	);
}

function applyVerdicts(artifact: RunnerJson, comparisons: readonly BaselineComparison[]): void {
	const byKey = new Map(comparisons.map((comparison) => [`${comparison.file}/${comparison.name}`, comparison.verdict]));
	for (const file of artifact.files) {
		const stem = stemOf(file.file);
		for (const result of file.results) {
			if (result.kind !== "bench") continue;

			const verdict = byKey.get(`${stem}/${result.name}`);
			if (verdict) result.verdict = verdict;
		}
	}
}

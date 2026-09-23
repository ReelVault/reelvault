import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { gc } from "bun";
import { printUsage, suiteArgs } from "./args";
import { type BaselineComparison, type BaselineEntry, type BaselineFile, compareWithBaseline, type Verdict } from "./baseline";
import { compareVariants, printAbResult } from "./compare";
import { benchmark, benchmarkAsync, type MicroBenchmarkResult, printMicroResults } from "./harness";
import { cleanupFixtures, collectUnits, markCollection, type Unit } from "./registry";
import { printTable } from "./report";
import { summarizeLatencies } from "./stats";

export interface BenchFileMeta {
	description?: string;
}

export interface RunnerJson {
	schema: "benchkit/v0";
	generatedAt: string;
	files: Array<{ file: string; description: string; results: UnitJson[] }>;
}

type UnitJson = BenchJson | CompareJson | TaskJson;

interface BenchJson {
	kind: "bench";
	name: string;
	group?: string | undefined;
	stats: ReturnType<typeof summarizeLatencies>;
	rows?: number;
	verdict?: Verdict | undefined;
}

interface CompareJson {
	kind: "compare";
	name: string;
	winner: string;
	equalOk: boolean;
	rows: string[];
}

interface TaskJson {
	kind: "task";
	name: string;
	ok: boolean;
	data?: unknown;
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

interface ExecutionOutcome {
	strictFailures: number;
}

/**
 * Executes units in registration order. Bench units buffer per group and
 * flush as one table; compare units and tasks print as they run.
 */
async function executeUnits(
	units: readonly Unit[],
	json: UnitJson[],
	baselineOut: BaselineEntry[] | undefined,
	fileStem: string,
): Promise<ExecutionOutcome> {
	let strictFailures = 0;
	let pendingGroup = "";
	let pending: MicroBenchmarkResult[] = [];
	const flush = (): void => {
		if (pending.length === 0) return;

		printMicroResults(pending, pendingGroup || undefined);
		pending = [];
	};

	for (const unit of units) {
		if (unit.kind !== "bench" || unit.group !== pendingGroup) flush();

		if (unit.kind === "bench") {
			pendingGroup = unit.group;
			// One extra warmup probe doubles as the sync/async detector.
			const probe = unit.fn({ iteration: 0 });
			const entry = isThenable(probe)
				? await benchmarkAsync(unit.name, (iteration) => Promise.resolve(unit.fn({ iteration })), unit.options)
				: benchmark(unit.name, (iteration) => unit.fn({ iteration }), unit.options);
			json.push({
				kind: "bench",
				name: entry.name,
				...(unit.group.length > 0 ? { group: unit.group } : {}),
				stats: summarizeLatencies(entry.timesMs),
				...(entry.rows !== undefined ? { rows: entry.rows } : {}),
			});
			baselineOut?.push({
				kind: "bench",
				file: fileStem,
				name: entry.name,
				samples: entry.timesMs,
				p50Ms: summarizeLatencies(entry.timesMs).p50Ms,
			});
			pending.push(entry);
		} else if (unit.kind === "compare") {
			const outcome = compareVariants(unit.name, unit.variants, { ...unit.options, equal: unit.equal });
			printAbResult(outcome.result, outcome.equalOk);
			if (!outcome.equalOk) strictFailures++;

			const compareJson: CompareJson = {
				kind: "compare",
				name: outcome.result.name,
				winner: outcome.result.winner,
				equalOk: outcome.equalOk,
				rows: outcome.result.rows,
			};
			json.push(compareJson);
		} else {
			const outcome = asTaskOutcome(await unit.fn());
			const taskJson: TaskJson = { kind: "task", name: unit.name, ok: outcome.ok };
			if (outcome.data !== undefined) taskJson.data = outcome.data;

			json.push(taskJson);
			if (!outcome.ok) {
				strictFailures++;
				console.warn(`[benchkit] task "${unit.name}" reported failure`);
			}
		}
	}

	flush();

	return { strictFailures };
}

export interface DiscoveryOptions {
	/** Absolute paths of *.bench.ts files (the caller globs them). */
	files: readonly string[];
	/** Command name for the usage line (e.g. "benchmark"). */
	command: string;
	target?: string | undefined;
	/** Unit-name regex filter (`--only`); only matching units run. */
	only?: string | undefined;
	/** Write raw bench samples as a baseline (`--save-baseline[=path]`). */
	saveBaseline?: string | undefined;
	/** Compare against a saved baseline and print verdicts (`--compare-baseline[=path]`). */
	compareBaseline?: string | undefined;
	jsonPath?: string | undefined;
	strict?: boolean | undefined;
}

const STEM_SUFFIX = ".bench.ts";
const STEM_SUFFIX_REGEX = /\.bench\.ts$/;

/** Compiles the `--only` unit-name filter; case-insensitive, undefined = no filter. */
export function compileOnlyFilter(pattern: string | undefined): RegExp | undefined {
	if (pattern === undefined || pattern.length === 0) return undefined;

	return new RegExp(pattern, "i");
}

function printRunnerUsage(command: string, stems: readonly string[]): void {
	printUsage(
		command,
		`\n\nAvailable suites:\n${stems.map((stem) => `  ${stem}`).join("\n")}\n  all          - Run all benchmark suites sequentially\n`,
	);
}

/** Reads the optional `meta.description` export off an imported bench file. */
function readDescription(module: unknown): string {
	if (typeof module === "object" && module !== null && "meta" in module) {
		const meta: unknown = module.meta;
		if (typeof meta === "object" && meta !== null && "description" in meta && typeof meta.description === "string") {
			return meta.description;
		}
	}

	return "";
}

/** Discovers, imports and runs *.bench.ts files sequentially, gc-ing between them. */
export async function runDiscovery(options: DiscoveryOptions): Promise<void> {
	const { files, command, target } = options;
	const stems = files.map((file) => basename(file).replace(STEM_SUFFIX, ""));

	if (!target || target === "help" || target === "--help" || target === "-h") {
		printRunnerUsage(command, stems);

		return;
	}

	if (files.length === 0) {
		console.error("No *.bench.ts files found.");
		process.exitCode = 1;

		return;
	}

	let selected: string[];
	if (target === "all") {
		selected = [...files];
	} else {
		const index = stems.indexOf(target);
		if (index === -1) {
			console.error(`Unknown benchmark suite: "${target}"\n`);
			printRunnerUsage(command, stems);
			process.exitCode = 1;

			return;
		}

		selected = [files[index] ?? ""];
	}

	const onlyPattern = options.only;
	let onlyRe: RegExp | undefined;
	if (onlyPattern !== undefined) {
		try {
			onlyRe = compileOnlyFilter(onlyPattern);
		} catch {
			console.error(`[benchkit] invalid --only regex: ${onlyPattern}`);
			process.exitCode = 1;

			return;
		}
	}

	const artifact: RunnerJson = { schema: "benchkit/v0", generatedAt: new Date().toISOString(), files: [] };
	const baselineEntries: BaselineEntry[] = [];
	let strictFailures = 0;
	let matchedUnits = 0;
	let regressions = 0;
	try {
		for (const file of selected) {
			const mark = markCollection();
			const module: unknown = await import(file);
			const collected = collectUnits(mark);
			const units = onlyRe ? collected.filter((unit) => onlyRe.test(unit.name)) : collected;
			matchedUnits += units.length;
			const description = readDescription(module);
			const stem = basename(file).replace(STEM_SUFFIX, "");
			console.log(`[benchkit] running suite "${stem}": ${description}\n`);

			const fileJson: RunnerJson["files"][number] = { file: basename(file), description, results: [] };
			const fileBaseline: BaselineEntry[] = [];
			const outcome = await executeUnits(units, fileJson.results, fileBaseline, stem);
			strictFailures += outcome.strictFailures;
			baselineEntries.push(...fileBaseline);
			artifact.files.push(fileJson);
			await cleanupFixtures();
			gc(true);
		}
	} catch (error) {
		console.error("Benchmark failed:", error);
		await cleanupFixtures();
		process.exitCode = 1;

		return;
	}

	if (options.compareBaseline) {
		const baseline = await readBaselineFile(options.compareBaseline);
		const { comparisons, missingInBaseline } = compareWithBaseline(baselineEntries, baseline.entries);
		printBaselineComparison(comparisons, options.compareBaseline, missingInBaseline);
		applyVerdicts(artifact, comparisons);
		regressions = comparisons.filter((comparison) => comparison.verdict === "slower").length;
	}

	if (options.saveBaseline) {
		const baselineFile: BaselineFile = { schema: "benchkit-baseline/v1", generatedAt: new Date().toISOString(), entries: baselineEntries };
		await mkdir(dirname(options.saveBaseline), { recursive: true });
		await writeFile(options.saveBaseline, `${JSON.stringify(baselineFile, null, "\t")}\n`);
		console.log(`\n[benchkit] baseline (${baselineEntries.length} bench units) saved to ${options.saveBaseline}`);
	}

	if (options.jsonPath) {
		await mkdir(dirname(options.jsonPath), { recursive: true });
		await writeFile(options.jsonPath, `${JSON.stringify(artifact, null, "\t")}\n`);
		console.log(`\n[benchkit] JSON results written to ${options.jsonPath}`);
	}

	if (onlyRe && matchedUnits === 0 && onlyPattern !== undefined) {
		console.error(`\n[benchkit] --only "${onlyPattern}" matched no units in ${selected.length} file(s).`);
		process.exitCode = 1;
	}

	if (options.strict && strictFailures > 0) {
		console.error(`\n[benchkit] strict mode: failing because ${strictFailures} unit(s) reported failure.`);
		process.exitCode = 1;
	}

	if (options.strict && regressions > 0) {
		console.error(`\n[benchkit] strict mode: failing because ${regressions} unit(s) regressed vs baseline.`);
		process.exitCode = 1;
	}
}

function isBaselineFile(value: unknown): value is BaselineFile {
	if (typeof value !== "object" || value === null) return false;

	if (!("schema" in value) || value.schema !== "benchkit-baseline/v1") return false;

	if (!("entries" in value && Array.isArray(value.entries))) return false;

	return true;
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
	console.log(
		`[benchkit] verdicts: ${comparisons.filter((c) => c.verdict === "faster").length} faster, ${comparisons.filter((c) => c.verdict === "slower").length} slower, ${comparisons.filter((c) => c.verdict === "unchanged").length} unchanged, ${comparisons.filter((c) => c.verdict === "noisy").length} noisy${missingInBaseline > 0 ? `, ${missingInBaseline} not in baseline` : ""}`,
	);
}

function applyVerdicts(artifact: RunnerJson, comparisons: readonly BaselineComparison[]): void {
	const byKey = new Map(comparisons.map((comparison) => [`${comparison.file}/${comparison.name}`, comparison.verdict]));
	for (const file of artifact.files) {
		const stem = file.file.replace(STEM_SUFFIX_REGEX, "");
		for (const result of file.results) {
			if (result.kind !== "bench") continue;

			const verdict = byKey.get(`${stem}/${result.name}`);
			if (verdict) result.verdict = verdict;
		}
	}
}

/** Runs the calling module's own units (standalone `bun run file.bench.ts` mode). */
export async function runFile(meta: ImportMeta): Promise<void> {
	const onlyRe = compileOnlyFilter(suiteArgs().only);
	const collected = collectUnits(0);
	const units = onlyRe ? collected.filter((unit) => onlyRe.test(unit.name)) : collected;
	if (units.length === 0) {
		if (onlyRe && collected.length > 0) {
			console.error(`[benchkit] ${basename(meta.path)}: --only "${onlyRe.source}" matched no units`);
		} else {
			console.error(`[benchkit] ${basename(meta.path)}: no bench/compare/task registrations — nothing to run`);
		}

		process.exitCode = 1;

		return;
	}

	try {
		await executeUnits(units, [], undefined, basename(meta.path).replace(STEM_SUFFIX, ""));
	} catch (error) {
		console.error("Benchmark failed:", error);
		process.exitCode = 1;
	} finally {
		await cleanupFixtures();
	}
}

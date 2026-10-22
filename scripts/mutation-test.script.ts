/**
 * `bun run mutation` — measures how much of the production code the test suite watches.
 *
 * Every production module that a test reaches, directly or through other modules and
 * test helpers, is a subject. For each subject the script applies one mutant at a time
 * (an operator flipped, a condition negated, a literal nudged, a call swapped) and runs
 * the test files that reach the subject. A mutant that a test kills is behavior the suite
 * notices; a survivor is a spot nobody watches.
 *
 * The measurement follows these rules:
 * - A mutant that does not transpile is stillborn. It is dropped before any test runs.
 * - A mutant whose transpiled output equals the original's is equivalent: the change is
 *   erased by the transpiler (a type, a type argument), so no test can observe it. It is
 *   dropped too, so a type-only change never counts as a survivor.
 * - A subject whose covering tests already fail on the untouched source is skipped and
 *   reported, so a red suite cannot inflate the score. A timeout on the untouched source
 *   is reported as a timeout.
 * - A run that times out counts as killed (a hang is a visible change) and is counted apart
 *   from assertion failures.
 * - Mutants are spread evenly over the module, so a long file is not judged by its first lines.
 * - Covering tests are the test files that reach the subject through imports, the one named
 *   after it first, then the nearest ones.
 * - One run at a time: a lock file records the process that holds the mutants in place.
 *
 * This measures **sensitivity, not correctness**. Mutation testing cannot tell an intended
 * change from an unintended one, so a suite can kill every mutant and still assert the wrong
 * value. A survivor is not automatically a missing test either: an unreachable branch can
 * survive without a behavior change. Use the report to find blind spots, never as a certificate.
 *
 * The script rewrites one production file at a time and restores it after every run,
 * including on Ctrl-C (its test process is killed too). Run it on its own: a test that reads
 * a file while a mutant is in place fails for the wrong reason. It is a local tool, not a CI gate.
 *
 * Usage:
 *   bun run mutation                            # every module a test reaches
 *   bun run mutation -- --files=ffmpeg          # only modules whose path matches
 *   bun run mutation -- --max-mutants=12        # more mutants per module
 *   bun run mutation -- --max-tests=5           # more covering test files per mutant
 *   bun run mutation -- --plan                  # counts and the run budget; no test runs
 *   bun run mutation -- --json                  # machine-readable report
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";

/** The folder the production code lives in. Its modules are the subjects. */
const SOURCE_ROOT = "src";

/** Test files and the helpers they import come from both roots: `tests/` holds the cross-cutting suites. */
const TEST_ROOTS = [SOURCE_ROOT, "tests"];

/** The alias the production code and the tests import through. */
const SOURCE_ALIAS = "@/";

const DEFAULT_MAX_MUTANTS = 6;
const DEFAULT_MAX_TESTS = 3;

/** A test file may run this long before bun itself fails it. */
const TEST_TIMEOUT_MS = 30_000;

/** A `bun test` process still alive after this long is killed, and the mutant counts as killed. */
const RUN_TIMEOUT_MS = 60_000;

/** Static `from "x"`, side-effect `import "x"` and dynamic `import("x")`. */
const IMPORT_PATTERN = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const WORD_PATTERN = /[\w$]/;

/** Marks a string, template or regular-expression literal while the scan is in code. */
const LITERAL_MARK = "literal";

/** After one of these punctuation marks a `/` opens a regular expression rather than dividing. */
const EXPRESSION_START_PUNCTUATION = new Set([
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
	"{",
	"}",
	";",
	"+",
	"-",
	"*",
	"%",
	"<",
	">",
	"~",
	"^",
]);

const EXPRESSION_START_KEYWORDS = new Set([
	"return",
	"typeof",
	"case",
	"do",
	"else",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"instanceof",
]);

/** The call a swapped-call mutant puts in place of the original. */
const CALL_SWAPS: Record<string, string> = {
	"Math.min": "Math.max",
	"Math.max": "Math.min",
	"Math.floor": "Math.ceil",
	"Math.ceil": "Math.floor",
	".some": ".every",
	".every": ".some",
};

/** The file that names the process holding the mutants in place, and the originals to put back. */
const RECOVERY_FILE = join(tmpdir(), "reelvault-mutation.json");

/** The originals of the files that currently hold a mutant. */
const pending = new Map<string, string>();

/** The test process in flight, so an interrupt kills it instead of leaving it to run against a mutant. */
let activeChild: ChildProcess | undefined;

type MutationClass = "stillborn" | "equivalent" | "viable";

interface Site {
	kind: string;
	index: number;
	before: string;
	after: string;
}

interface Mutant extends Site {
	line: number;
}

type SiteFinder = (masked: string, source: string) => Site[];

interface Analysis {
	viable: Mutant[];
	stillborn: number;
	equivalent: number;
	baseline: string;
}

interface Options {
	files: string[] | undefined;
	maxMutants: number;
	maxTests: number;
	json: boolean;
	plan: boolean;
}

interface TestReach {
	path: string;
	/** Production modules the test reaches, with the import hops to each (1 = imported directly). */
	reached: Map<string, number>;
}

interface Survivor {
	subject: string;
	line: number;
	kind: string;
	before: string;
	after: string;
	tests: string[];
}

interface SubjectResult {
	subject: string;
	skipped: string | undefined;
	stillborn: number;
	equivalent: number;
	tried: number;
	killed: number;
	timedOut: number;
	survivors: Survivor[];
}

interface PlanLine {
	subject: string;
	viable: number;
	sampled: number;
	tests: string[];
}

interface Summary {
	score: number | null;
	killed: number;
	survived: number;
	timedOut: number;
	stillborn: number;
	equivalent: number;
	skipped: Array<{ subject: string; reason: string }>;
	survivors: Survivor[];
	unwatched: string[];
}

interface RunOutcome {
	passed: boolean;
	timedOut: boolean;
}

type MutantVerdict = { killed: false } | { killed: true; timedOut: boolean };

interface RecoveryRecord {
	pid: number;
	originals: Array<[string, string]>;
}

/** Hooks the exit paths: an interrupted run puts every original back and stops its test process. */
function stopRun(): void {
	activeChild?.kill("SIGKILL");
	activeChild = undefined;
	restorePending();
}

process.on("exit", stopRun);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopRun();
		process.exit(130);
	});
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Every production or test module of the repository that a rule below accepts. */
function isTestPath(path: string): boolean {
	return path.endsWith(".test.ts");
}

function isProductionPath(path: string): boolean {
	return path.startsWith(`${SOURCE_ROOT}/`) && !isTestPath(path);
}

function readOptions(): Options {
	const args = process.argv.slice(2);
	const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

	return {
		files: value("files")?.split(","),
		maxMutants: positiveInt(value("max-mutants"), DEFAULT_MAX_MUTANTS),
		maxTests: positiveInt(value("max-tests"), DEFAULT_MAX_TESTS),
		json: args.includes("--json"),
		plan: args.includes("--plan"),
	};
}

function positiveInt(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);

	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Every `.ts` file below a folder, as repository-relative paths. Declaration files are not modules. */
function collectTypeScript(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) files.push(...collectTypeScript(path));
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(path);
	}

	return files;
}

/** The repository file a relative or `@/` specifier points at, or undefined for a package import. */
function resolveLocalImport(specifier: string, fromFile: string): string | undefined {
	let base: string;
	if (specifier.startsWith("./") || specifier.startsWith("../")) base = resolvePath(dirname(fromFile), specifier);
	else if (specifier.startsWith(SOURCE_ALIAS)) base = resolvePath(SOURCE_ROOT, specifier.slice(SOURCE_ALIAS.length));
	else return undefined;

	for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate)) return relative(process.cwd(), candidate);
	}

	return undefined;
}

/** The repository files one module imports directly. Commented-out imports do not count. */
function readLocalImports(file: string): string[] {
	const source = maskCode(readFileSync(file, "utf8"), false);
	const imports = new Set<string>();
	for (const match of source.matchAll(IMPORT_PATTERN)) {
		const target = resolveLocalImport(match[1] ?? "", file);
		if (target !== undefined) imports.add(target);
	}

	return [...imports];
}

/** The production modules a test file reaches through imports, nearest first. Helpers under `tests/` are passed through, not subjects. */
function reachedModules(start: string, graph: Map<string, string[]>): Map<string, number> {
	const hops = new Map<string, number>([[start, 0]]);
	const queue: string[] = [start];
	for (const current of queue) {
		const next = (hops.get(current) ?? 0) + 1;
		for (const target of graph.get(current) ?? []) {
			if (hops.has(target)) continue;
			hops.set(target, next);
			queue.push(target);
		}
	}

	const reached = new Map<string, number>();
	for (const [file, count] of hops) {
		if (file !== start && isProductionPath(file)) reached.set(file, count);
	}

	return reached;
}

/**
 * The test files that reach the subject, the one named after it first, then the ones in its
 * folder, then the rest. Within each rank, fewer import hops come first. The limit keeps one
 * mutant from running the whole suite.
 */
function coveringTests(subject: string, reaches: TestReach[], limit: number): string[] {
	const name = basename(subject, ".ts");
	const rank = (path: string): 0 | 1 | 2 => {
		if (basename(path) === `${name}.test.ts`) return 0;

		return dirname(path) === dirname(subject) ? 1 : 2;
	};

	return reaches
		.filter((reach) => reach.reached.has(subject))
		.toSorted(
			(left, right) =>
				rank(left.path) - rank(right.path) ||
				(left.reached.get(subject) ?? 0) - (right.reached.get(subject) ?? 0) ||
				left.path.localeCompare(right.path),
		)
		.slice(0, limit)
		.map((reach) => reach.path);
}

/**
 * The source with comments blanked, and with string, template and regular-expression literals
 * blanked too when `blankLiterals` is set. Length and line breaks are kept, so an index in the
 * masked text is the same position in the file.
 */
function maskCode(source: string, blankLiterals: boolean): string {
	const state: MaskState = { source, masked: source.split(""), blankLiterals };
	scanCode(state, 0, false);

	return state.masked.join("");
}

interface MaskState {
	source: string;
	masked: string[];
	blankLiterals: boolean;
}

/**
 * Scans code from `from`. Inside a template substitution it stops after the `}` that closes the
 * substitution and returns the index after it, so a template nested in a substitution is found.
 */
function scanCode(state: MaskState, from: number, inSubstitution: boolean): number {
	const { source } = state;
	let depth = 0;
	let previous = "";
	let index = from;
	while (index < source.length) {
		const commentEnd = commentEndAt(source, index);
		if (commentEnd !== undefined) {
			index = blankRange(state, index, commentEnd, false);
			continue;
		}

		const literalEnd = literalEndAt(state, index, previous);
		if (literalEnd !== undefined) {
			index = literalEnd;
			previous = LITERAL_MARK;
			continue;
		}

		const char = source.charAt(index);
		if (WORD_PATTERN.test(char)) {
			const start = index;
			index = wordEnd(source, index);
			previous = source.slice(start, index);
			continue;
		}

		if (char === "{") depth++;
		else if (char === "}") {
			if (inSubstitution && depth === 0) return index + 1;
			depth--;
		}
		if (char.trim() !== "") previous = char;
		index++;
	}

	return index;
}

/** The end of the comment that starts at `index`, or undefined when no comment starts there. */
function commentEndAt(source: string, index: number): number | undefined {
	if (source.startsWith("//", index)) return lineEnd(source, index);
	if (source.startsWith("/*", index)) return blockCommentEnd(source, index);

	return undefined;
}

/** The end of the string, template or regular expression that starts at `index`, or undefined. */
function literalEndAt(state: MaskState, index: number, previous: string): number | undefined {
	const { source } = state;
	switch (source.charAt(index)) {
		case '"':
		case "'":
			return blankRange(state, index, quotedEnd(source, index), true);
		case "`":
			return scanTemplate(state, index);
		case "/":
			return regexMayStart(previous) ? blankRange(state, index, regexEnd(source, index), true) : undefined;
		default:
			return undefined;
	}
}

/** Scans the template literal that opens at `from`. Its text is blanked; each `${...}` substitution is scanned as code. */
function scanTemplate(state: MaskState, from: number): number {
	const { source } = state;
	let textStart = from;
	let index = from + 1;
	while (index < source.length) {
		const char = source.charAt(index);
		if (char === "\\") index += 2;
		else if (char === "`") return blankRange(state, textStart, index + 1, true);
		else if (char === "$" && source.charAt(index + 1) === "{") {
			blankRange(state, textStart, index, true);
			index = scanCode(state, index + 2, true);
			textStart = index;
		} else index++;
	}
	blankRange(state, textStart, source.length, true);

	return source.length;
}

/** Blanks `[from, to)` unless it is a literal and literals are kept. Returns `to`. */
function blankRange(state: MaskState, from: number, to: number, isLiteral: boolean): number {
	if (isLiteral && !state.blankLiterals) return to;
	for (let index = from; index < to; index++) {
		if (state.masked[index] !== "\n") state.masked[index] = " ";
	}

	return to;
}

function lineEnd(source: string, from: number): number {
	const newline = source.indexOf("\n", from);

	return newline === -1 ? source.length : newline;
}

function blockCommentEnd(source: string, from: number): number {
	const close = source.indexOf("*/", from + 2);

	return close === -1 ? source.length : close + 2;
}

function quotedEnd(source: string, from: number): number {
	const quote = source.charAt(from);
	let index = from + 1;
	while (index < source.length) {
		const char = source.charAt(index);
		if (char === "\\") index += 2;
		else if (char === quote) return index + 1;
		else if (char === "\n") return index;
		else index++;
	}

	return source.length;
}

function regexEnd(source: string, from: number): number {
	let inClass = false;
	let index = from + 1;
	while (index < source.length) {
		const char = source.charAt(index);
		index += char === "\\" ? 2 : 1;
		if (char === "\n") return index - 1;
		if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) return wordEnd(source, index);
	}

	return source.length;
}

function wordEnd(source: string, from: number): number {
	let index = from;
	while (index < source.length && WORD_PATTERN.test(source.charAt(index))) index++;

	return index;
}

function regexMayStart(previous: string): boolean {
	return previous === "" || EXPRESSION_START_PUNCTUATION.has(previous) || EXPRESSION_START_KEYWORDS.has(previous);
}

/** A finder for every match of `pattern` in the code. The replacement is computed from the matched text. */
function patternSites(kind: string, pattern: RegExp, replacement: (matched: string) => string): SiteFinder {
	return (masked, source) => {
		const sites: Site[] = [];
		for (const match of masked.matchAll(pattern)) {
			const index = match.index;
			const before = match[0];
			if (source.slice(index, index + before.length) !== before) continue;
			sites.push({ kind, index, before, after: replacement(before) });
		}

		return sites;
	};
}

/** Every `if (...)` condition, negated as a whole. The masked text keeps strings and comments out of the parenthesis count. */
function conditionSites(masked: string, source: string): Site[] {
	const sites: Site[] = [];
	for (const match of masked.matchAll(/\bif\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		const close = closingParen(masked, open);
		if (close === undefined) continue;
		const condition = source.slice(open + 1, close);
		if (condition.trim() === "") continue;
		sites.push({ kind: "if-negation", index: open + 1, before: condition, after: `!(${condition})` });
	}

	return sites;
}

function closingParen(masked: string, open: number): number | undefined {
	let depth = 0;
	for (let index = open; index < masked.length; index++) {
		const char = masked.charAt(index);
		if (char === "(") depth++;
		else if (char === ")") {
			depth--;
			if (depth === 0) return index;
		}
	}

	return undefined;
}

const SITE_FINDERS: SiteFinder[] = [
	patternSites("equality", /(?<![=!<>])===(?!=)/g, () => "!=="),
	patternSites("inequality", /!==/g, () => "==="),
	patternSites("at-least", /(?<![=!<>])>=/g, () => ">"),
	patternSites("greater", /(?<![=!<>-])>(?![>=])/g, () => ">="),
	patternSites("at-most", /(?<!<)<=/g, () => "<"),
	patternSites("less", /(?<![<=])<(?![<=])/g, () => "<="),
	patternSites("and", /&&/g, () => "||"),
	patternSites("or", /\|\|/g, () => "&&"),
	patternSites("nullish", /\?\?(?!=)/g, () => "||"),
	patternSites("optional-chain", /\?\.(?!\d)/g, () => "."),
	patternSites("truthy", /\btrue\b/g, () => "false"),
	patternSites("falsy", /\bfalse\b/g, () => "true"),
	patternSites("negation", /(?<![\w$)\]])!(?!=)/g, () => ""),
	patternSites("number", /(?<![\w$.])\d+(?![\w$.])/g, (text) => String(Number(text) + 1)),
	patternSites("call-swap", /\bMath\.(?:min|max|floor|ceil)\b|\.(?:some|every)\b/g, (text) => CALL_SWAPS[text] ?? text),
	conditionSites,
];

/** Every mutation site in the code of a module, in source order. */
function readMutants(source: string): Mutant[] {
	const masked = maskCode(source, true);
	const starts = lineStarts(source);
	const mutants: Mutant[] = [];
	for (const finder of SITE_FINDERS) {
		for (const site of finder(masked, source)) mutants.push({ ...site, line: lineAt(starts, site.index) });
	}

	return mutants.toSorted((left, right) => left.index - right.index);
}

function lineStarts(source: string): number[] {
	const starts = [0];
	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);

	return starts;
}

/** The 1-based line of an index, by binary search over the line starts. */
function lineAt(starts: number[], index: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((starts[middle] ?? 0) <= index) low = middle;
		else high = middle - 1;
	}

	return low + 1;
}

/** The source with one mutant applied. The splice is done on the original text. */
function applyMutant(source: string, mutant: Site): string {
	return source.slice(0, mutant.index) + mutant.after + source.slice(mutant.index + mutant.before.length);
}

function transpileOrUndefined(source: string): string | undefined {
	try {
		return transpiler.transformSync(source);
	} catch {
		return undefined;
	}
}

/** Stillborn when the mutant does not transpile; equivalent when its output is the original's; viable otherwise. */
function classify(mutated: string, baseline: string): MutationClass {
	const output = transpileOrUndefined(mutated);
	if (output === undefined) return "stillborn";

	return output === baseline ? "equivalent" : "viable";
}

/** The viable mutants of a module, with the counts of the dropped ones. Undefined when the untouched source does not transpile. */
function analyse(source: string): Analysis | undefined {
	const baseline = transpileOrUndefined(source);
	if (baseline === undefined) return undefined;

	const viable: Mutant[] = [];
	let stillborn = 0;
	let equivalent = 0;
	for (const mutant of readMutants(source)) {
		const verdict = classify(applyMutant(source, mutant), baseline);
		if (verdict === "viable") viable.push(mutant);
		else if (verdict === "equivalent") equivalent++;
		else stillborn++;
	}

	return { viable, stillborn, equivalent, baseline };
}

/** Mutants spread evenly over the module, so a long file is not judged by its first lines. */
function sampleEvenly(mutants: Mutant[], limit: number): Mutant[] {
	if (mutants.length <= limit) return mutants;

	const sample: Mutant[] = [];
	for (let slot = 0; slot < limit; slot++) {
		const mutant = mutants[Math.floor((slot * mutants.length) / limit)];
		if (mutant !== undefined) sample.push(mutant);
	}

	return sample;
}

/** Runs one test file in its own bun process. Exit code 0 is a pass; bun exits 1 on any failure. */
function runTest(file: string): Promise<RunOutcome> {
	return new Promise((resolve, reject) => {
		let timedOut = false;
		const child = spawn(process.execPath, ["test", file, "--timeout", String(TEST_TIMEOUT_MS)], {
			env: { ...process.env, CI: "1" },
			stdio: "ignore",
		});
		activeChild = child;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, RUN_TIMEOUT_MS);
		const finish = () => {
			clearTimeout(timer);
			activeChild = undefined;
		};
		child.on("error", (error) => {
			finish();
			reject(error);
		});
		child.on("close", (code) => {
			finish();
			resolve({ passed: code === 0 && !timedOut, timedOut });
		});
	});
}

/** The outcome of a test file on the untouched source. Each file runs once and is remembered. */
async function isGreen(test: string, cache: Map<string, RunOutcome>): Promise<RunOutcome> {
	const known = cache.get(test);
	if (known !== undefined) return known;

	const outcome = await runTest(test);
	cache.set(test, outcome);

	return outcome;
}

/** Applies one mutant, runs the covering tests until one fails, and always restores the original. */
async function judgeMutant(subject: string, source: string, mutant: Mutant, covering: string[]): Promise<MutantVerdict> {
	pending.set(subject, source);
	syncRecovery();
	try {
		writeFileSync(subject, applyMutant(source, mutant));
		for (const test of covering) {
			const outcome = await runTest(test);
			if (!outcome.passed) return { killed: true, timedOut: outcome.timedOut };
		}

		return { killed: false };
	} finally {
		writeFileSync(subject, source);
		pending.delete(subject);
		syncRecovery();
	}
}

function skipped(subject: string, reason: string): SubjectResult {
	return { subject, skipped: reason, stillborn: 0, equivalent: 0, tried: 0, killed: 0, timedOut: 0, survivors: [] };
}

async function measureSubject(
	subject: string,
	covering: string[],
	options: Options,
	green: Map<string, RunOutcome>,
): Promise<SubjectResult> {
	const source = readFileSync(subject, "utf8");
	const analysis = analyse(source);
	if (analysis === undefined) return skipped(subject, "the untouched source does not transpile");

	for (const test of covering) {
		const outcome = await isGreen(test, green);
		if (outcome.passed) continue;
		const reason = outcome.timedOut
			? `covering test timed out on the untouched source: ${test}`
			: `covering test is red without a mutation: ${test}`;

		return skipped(subject, reason);
	}

	const sampled = sampleEvenly(analysis.viable, options.maxMutants);
	const result: SubjectResult = {
		subject,
		skipped: undefined,
		stillborn: analysis.stillborn,
		equivalent: analysis.equivalent,
		tried: sampled.length,
		killed: 0,
		timedOut: 0,
		survivors: [],
	};
	for (const mutant of sampled) {
		const verdict = await judgeMutant(subject, source, mutant, covering);
		if (verdict.killed) {
			result.killed++;
			if (verdict.timedOut) result.timedOut++;
		} else {
			result.survivors.push({ subject, line: mutant.line, kind: mutant.kind, before: mutant.before, after: mutant.after, tests: covering });
		}
	}

	return result;
}

/** The run budget of one subject, without running a test. */
function planSubject(subject: string, covering: string[], options: Options): PlanLine {
	const analysis = analyse(readFileSync(subject, "utf8"));
	const viable = analysis?.viable.length ?? 0;
	const sampled = Math.min(viable, options.maxMutants);

	return { subject, viable, sampled, tests: covering };
}

function summarize(results: SubjectResult[], unwatched: string[]): Summary {
	const killed = results.reduce((total, result) => total + result.killed, 0);
	const survivors = results.flatMap((result) => result.survivors);
	const judged = killed + survivors.length;

	return {
		score: judged === 0 ? null : (killed / judged) * 100,
		killed,
		survived: survivors.length,
		timedOut: results.reduce((total, result) => total + result.timedOut, 0),
		stillborn: results.reduce((total, result) => total + result.stillborn, 0),
		equivalent: results.reduce((total, result) => total + result.equivalent, 0),
		skipped: results.flatMap((result) => (result.skipped === undefined ? [] : [{ subject: result.subject, reason: result.skipped }])),
		survivors,
		unwatched,
	};
}

function printProgress(result: SubjectResult): void {
	if (result.skipped === undefined) console.log(`  ${result.subject}  killed ${result.killed}/${result.tried}`);
	else console.log(`  ${result.subject}  skipped: ${result.skipped}`);
}

function printPlan(plans: PlanLine[], unwatched: string[]): void {
	for (const plan of plans) console.log(`  ${plan.subject}  viable ${plan.viable}  sampled ${plan.sampled}  tests ${plan.tests.length}`);
	const mutants = plans.reduce((total, plan) => total + plan.sampled, 0);
	const runs = plans.reduce((total, plan) => total + plan.sampled * plan.tests.length, 0);
	const testFiles = new Set(plans.flatMap((plan) => plan.tests)).size;
	console.log(`\nsubjects: ${plans.length}; unwatched modules: ${unwatched.length}`);
	console.log(`mutants: ${mutants} at most; test runs: ${runs} at most; green checks: ${testFiles} test files`);
	console.log("each mutant stops at its first killing test, so the real count of test runs is lower");
}

function printReport(summary: Summary): void {
	const score = summary.score === null ? "n/a (no viable mutant was run)" : `${summary.score.toFixed(1)}%`;
	console.log(
		`\nmutation score: ${score} (${summary.killed} killed, ${summary.survived} survived; ${summary.timedOut} of the killed timed out; ${summary.stillborn} stillborn and ${summary.equivalent} equivalent excluded)`,
	);
	if (summary.survivors.length > 0) {
		console.log(`\nsurvived (${summary.survivors.length}):`);
		for (const survivor of summary.survivors) {
			console.log(
				`  ${survivor.subject}:${survivor.line}  ${survivor.kind}  ${JSON.stringify(survivor.before)} -> ${JSON.stringify(survivor.after)}`,
			);
		}
	}
	for (const skip of summary.skipped) console.log(`skipped ${skip.subject}: ${skip.reason}`);
	console.log(`unwatched modules (no test reaches them): ${summary.unwatched.length}`);
}

/** Puts back every original a run still holds, then clears the record. */
function restorePending(): void {
	for (const [file, original] of pending) writeFileSync(file, original);
	pending.clear();
	syncRecovery();
}

/** Writes the record while mutants are in place, and removes it when none are. */
function syncRecovery(): void {
	if (pending.size === 0) rmSync(RECOVERY_FILE, { force: true });
	else writeFileSync(RECOVERY_FILE, JSON.stringify({ pid: process.pid, originals: [...pending] } satisfies RecoveryRecord));
}

function isPair(value: unknown): value is [string, string] {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"pid" in value &&
		typeof value.pid === "number" &&
		"originals" in value &&
		Array.isArray(value.originals) &&
		value.originals.every(isPair)
	);
}

/** The record an earlier run left, or undefined when there is none or it cannot be read. */
function readRecovery(): RecoveryRecord | undefined {
	if (!existsSync(RECOVERY_FILE)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(RECOVERY_FILE, "utf8"));

		return isRecoveryRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/** Puts back the originals an interrupted run left mutated, and refuses to start while another run holds the files. */
function claimWorkspace(): void {
	const record = readRecovery();
	if (record !== undefined && record.pid !== process.pid && isProcessAlive(record.pid)) {
		console.error(`another mutation run (pid ${record.pid}) is active; wait for it to finish`);
		process.exit(1);
	}
	if (record !== undefined) {
		for (const [file, original] of record.originals) writeFileSync(file, original);
		console.log(`restored ${record.originals.length} file(s) left mutated by an interrupted run`);
	}
	rmSync(RECOVERY_FILE, { force: true });
}

claimWorkspace();
const options = readOptions();
const files = TEST_ROOTS.flatMap((root) => collectTypeScript(root));
const graph = new Map(files.map((file): [string, string[]] => [file, readLocalImports(file)]));
const reaches: TestReach[] = files.filter((file) => isTestPath(file)).map((path) => ({ path, reached: reachedModules(path, graph) }));
const reachedAll = new Set(reaches.flatMap((reach) => [...reach.reached.keys()]));
const unwatched = files.filter((file) => isProductionPath(file) && !reachedAll.has(file)).toSorted();
const subjects = [...reachedAll]
	.filter((subject) => options.files === undefined || options.files.some((pattern) => subject.includes(pattern)))
	.toSorted();

if (options.plan) {
	const plans: PlanLine[] = subjects.map((subject) => planSubject(subject, coveringTests(subject, reaches, options.maxTests), options));
	if (options.json) console.log(JSON.stringify({ plans, unwatched }, null, 2));
	else printPlan(plans, unwatched);
} else {
	const green = new Map<string, RunOutcome>();
	const results: SubjectResult[] = [];
	for (const subject of subjects) {
		const result = await measureSubject(subject, coveringTests(subject, reaches, options.maxTests), options, green);
		results.push(result);
		if (!options.json) printProgress(result);
	}

	const summary = summarize(results, unwatched);
	if (options.json) console.log(JSON.stringify(summary, null, 2));
	else printReport(summary);
}

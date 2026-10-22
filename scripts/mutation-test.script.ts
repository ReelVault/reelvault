/**
 * `bun run mutation` — measures how much of the implementation the suite actually
 * watches.
 *
 * The script rewrites the production code with a small set of semantic mutants
 * and runs the test file that covers it. A mutant that the suite kills is a
 * behavior the suite protects; a mutant that survives is a spot nobody watches.
 *
 * This measures **sensitivity, not correctness**. Mutation testing cannot tell
 * an intended change from an unintended one, so a suite can kill every mutant
 * and still assert the wrong value. Use the report to find dead weight and
 * blind spots, never as a certificate that the code is right.
 *
 * The script rewrites the production file under the cursor and restores it
 * after every run, so the working tree ends where it started. It must not run
 * while something else reads the repository: a test that starts in the middle
 * of a mutation reads a broken file and fails for the wrong reason. Run it on
 * its own.
 *
 * Usage:
 *   bun run mutation                     # every test file
 *   bun run mutation -- --files=ffmpeg   # only files whose path matches
 *   bun run mutation -- --max-mutants=12 # more mutants per source file
 *   bun run mutation -- --json           # machine-readable report
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The folder the production code lives in. */
const SOURCE_ROOT = "src";

const IMPORTED_MODULE_PATTERN = /(?:from\s*|import\s*\(\s*)"([^"]+)"/g;
const LITERAL_PATTERN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const FAILED_TEST_PATTERN = /[1-9]\d* fail/;
const EQUALITY_PATTERN = /===(?![=])/g;
const INEQUALITY_PATTERN = /!==/g;
const AT_LEAST_PATTERN = />=(?![=])/g;
const GREATER_PATTERN = />(?![>=])/g;
const AT_MOST_PATTERN = /<=(?![=])/g;
const LESS_PATTERN = /<(?![<=])/g;
const NULLISH_PATTERN = /\?\?/g;
const TRUTHY_PATTERN = /\btrue\b/g;
const FALSY_PATTERN = /\bfalse\b/g;
const NUMBER_PATTERN = /(?<![\w.$])(\d+)(?![\w.])/g;

/** The alias the production code imports through. */
const SOURCE_ALIAS = "@/";

/** How many mutants a source file gets by default. */
const DEFAULT_MAX_MUTANTS = 6;

/** How long a single test run may take before it is killed. */
const RUN_TIMEOUT_MS = 60_000;

interface Mutant {
	kind: string;
	before: string;
	after: string;
	index: number;
}

interface Kill {
	kind: string;
	before: string;
	killed: boolean;
	timedOut: boolean;
}

/** The command-line flags the script understands. */
function readFlags(): { files: string | undefined; maxMutants: number; json: boolean } {
	const args = process.argv.slice(2);
	const files = args.find((arg) => arg.startsWith("--files="))?.slice("--files=".length);
	const maxMutants = Number(args.find((arg) => arg.startsWith("--max-mutants="))?.slice("--max-mutants=".length));
	return {
		files: files,
		maxMutants: Number.isFinite(maxMutants) && maxMutants > 0 ? maxMutants : DEFAULT_MAX_MUTANTS,
		json: args.includes("--json"),
	};
}

/** Every test file in the repository. */
function collectTestFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules" || entry === "dist" || entry === "build") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) files.push(...collectTestFiles(path));
		else if (entry.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

/** The production file a specifier points at, when it points at one. */
function resolveProductionModule(specifier: string, directory: string): string | undefined {
	let base: string;
	if (specifier.startsWith("./") || specifier.startsWith("../")) base = join(directory, specifier);
	else if (specifier.startsWith(SOURCE_ALIAS)) base = join(SOURCE_ROOT, specifier.slice(SOURCE_ALIAS.length));
	else return undefined;
	for (const candidate of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(candidate)) return candidate;
	return undefined;
}

/** The production modules a file imports, static or dynamic. */
function readImportedModules(source: string, directory: string): string[] {
	const modules = new Set<string>();
	const pattern = new RegExp(IMPORTED_MODULE_PATTERN.source, "g");
	let match = pattern.exec(source);
	while (match !== null) {
		const resolved = resolveProductionModule(match[1] ?? "", directory);
		if (resolved?.startsWith(SOURCE_ROOT)) modules.add(resolved);
		match = pattern.exec(source);
	}
	return [...modules];
}

/**
 * The modules a test file exercises: the module it is named after, or the
 * modules it imports from its own folder.
 */
function readSubjectModules(file: string, source: string): string[] {
	const directory = dirname(file);
	const base = file.split("/").pop()?.replace(".test.ts", "") ?? "";
	const namesake = resolveProductionModule(`./${base}`, directory);
	if (namesake?.startsWith(SOURCE_ROOT)) return [namesake];
	const modules = new Set<string>();
	for (const module of readImportedModules(source, directory)) {
		if (dirname(module) === directory) modules.add(module);
	}
	return [...modules];
}

/** Blanks out string and template contents so a mutation only touches code. */
function maskLiterals(source: string): string {
	return source.replaceAll(LITERAL_PATTERN, (literal) => literal.replaceAll(/[^\n]/g, " "));
}

/** The mutants of a source file, spread across the mutation kinds. */
function readMutants(source: string): Mutant[] {
	const masked = maskLiterals(source);
	const mutants: Mutant[] = [];
	const kinds: Array<{ kind: string; pattern: RegExp; after: (match: RegExpExecArray) => string }> = [
		{ kind: "equality", pattern: EQUALITY_PATTERN, after: () => "!==" },
		{ kind: "inequality", pattern: INEQUALITY_PATTERN, after: () => "===" },
		{ kind: "at-least", pattern: AT_LEAST_PATTERN, after: () => ">" },
		{ kind: "greater", pattern: GREATER_PATTERN, after: () => ">=" },
		{ kind: "at-most", pattern: AT_MOST_PATTERN, after: () => "<" },
		{ kind: "less", pattern: LESS_PATTERN, after: () => "<=" },
		{ kind: "nullish", pattern: NULLISH_PATTERN, after: () => "||" },
		{ kind: "truthy", pattern: TRUTHY_PATTERN, after: () => "false" },
		{ kind: "falsy", pattern: FALSY_PATTERN, after: () => "true" },
		{ kind: "number", pattern: NUMBER_PATTERN, after: (match) => String(Number(match[1]) + 1) },
	];
	for (const { kind, pattern, after } of kinds) {
		let match = pattern.exec(masked);
		while (match !== null) {
			const replacement = after(match);
			if (replacement !== match[0]) mutants.push({ kind, before: match[0], after: replacement, index: match.index });
			match = pattern.exec(masked);
		}
	}
	return mutants;
}

/** The mutants to try, spread across the kinds so one file is not all equality. */
function selectMutants(mutants: Mutant[], limit: number): Mutant[] {
	const byKind = new Map<string, Mutant[]>();
	for (const mutant of mutants) {
		const list = byKind.get(mutant.kind) ?? [];
		list.push(mutant);
		byKind.set(mutant.kind, list);
	}
	const chosen: Mutant[] = [];
	let round = 0;
	while (chosen.length < limit) {
		let added = false;
		for (const list of byKind.values()) {
			const candidate = list[round];
			if (candidate === undefined) continue;
			chosen.push(candidate);
			added = true;
			if (chosen.length >= limit) break;
		}
		if (!added) break;
		round++;
	}
	return chosen;
}

/**
 * The source with one mutant applied.
 *
 * The mutation site is located on the masked source, but the splice is done on
 * the original: the mask only hides string literals from the mutation patterns,
 * and splicing it would blank every literal in the file instead of changing
 * one spot. The mask keeps the length, so the indices line up.
 */
function applyMutant(source: string, mutant: Mutant): string {
	return source.slice(0, mutant.index) + mutant.after + source.slice(mutant.index + mutant.before.length);
}

/** Runs a test file and reports whether it passed. */
function runTest(file: string): Promise<{ passed: boolean; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("bun", ["test", file, "--timeout", "30000"], { env: { ...process.env, CI: "1" } });
		let output = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ passed: false, timedOut: true });
		}, RUN_TIMEOUT_MS);
		const decoder = new TextDecoder();
		child.stdout.on("data", (chunk: Uint8Array) => {
			output += decoder.decode(chunk);
		});
		child.stderr.on("data", (chunk: Uint8Array) => {
			output += decoder.decode(chunk);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const failed = FAILED_TEST_PATTERN.test(output) || (code !== 0 && !output.includes("0 fail"));
			resolve({ passed: !failed, timedOut: false });
		});
	});
}

/**
 * The files that currently hold a mutant. An interrupted run must not leave a
 * mutated source file behind, so the originals are restored on the way out.
 */
const pending = new Map<string, string>();

function restorePending(): void {
	for (const [file, original] of pending) writeFileSync(file, original);
	pending.clear();
}

process.on("exit", restorePending);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		restorePending();
		process.exit(1);
	});
}

/** The mutation report for one test file. */
interface Report {
	file: string;
	sources: string[];
	kills: Kill[];
}

/** Mutates every source of every test file and records which mutants the suite kills. */
async function measure(flags: { files: string | undefined; maxMutants: number }): Promise<Report[]> {
	const reports: Report[] = [];
	const testFiles = [...collectTestFiles(SOURCE_ROOT), ...collectTestFiles("tests")];
	for (const testFile of testFiles) {
		const relativePath = relative(".", testFile);
		if (flags.files !== undefined && !relativePath.includes(flags.files)) continue;
		const source = readFileSync(testFile, "utf8");
		const subjects = readSubjectModules(testFile, source);
		if (subjects.length === 0) continue;
		const kills: Kill[] = [];
		for (const subject of subjects) {
			const subjectSource = readFileSync(subject, "utf8");
			const mutants = selectMutants(readMutants(subjectSource), flags.maxMutants);
			for (const mutant of mutants) {
				pending.set(subject, subjectSource);
				writeFileSync(subject, applyMutant(subjectSource, mutant));
				let outcome = { passed: true, timedOut: false };
				try {
					outcome = await runTest(testFile);
				} finally {
					pending.delete(subject);
					writeFileSync(subject, subjectSource);
				}
				kills.push({ kind: mutant.kind, before: mutant.before, killed: !outcome.passed, timedOut: outcome.timedOut });
			}
		}
		reports.push({ file: relativePath, sources: subjects.map((subject) => relative(".", subject)), kills });
	}
	return reports;
}

/** Prints the human-readable report. */
function printReport(reports: Report[]): void {
	const all = reports.flatMap((report) => report.kills);
	const survived = all.filter((kill) => !kill.killed);
	console.log(
		`mutation score: ${(((all.length - survived.length) / all.length) * 100).toFixed(1)}% (${all.length - survived.length}/${all.length} mutants killed)`,
	);
	const gaps = reports.filter((report) => report.kills.some((kill) => !kill.killed));
	if (gaps.length > 0) {
		console.log(`\nuncovered mutants in ${gaps.length} file(s):`);
		for (const report of gaps) {
			for (const kill of report.kills) {
				if (kill.killed) continue;
				console.log(`  ${report.file} :: ${kill.kind} ${kill.before}`);
			}
		}
	}
}

const flags = readFlags();
const reports = await measure(flags);
if (flags.json) console.log(JSON.stringify(reports, null, 2));
else printReport(reports);

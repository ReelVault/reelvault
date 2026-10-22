/**
 * `bun run lint:tests` — fails on test files that cannot catch a bug.
 *
 * The linters check style, not meaning. A test may pass every linter and
 * still protect nothing: it may recompute the expected value with the code
 * under test, assert that a value exists, or assert that a mock was called.
 * Those shapes are invisible to Biome and oxlint, so they are checked here.
 *
 * Every rule below encodes one rule from `.claude/rules/testing.md`:
 *
 *  - R1  the expected side of an assertion may not call a function of the code
 *       under test — the expectation must be a fact, not a recomputation of the
 *       subject;
 *  - R2  a constant used as the expected value may not be built from a function
 *       of the code under test — the same closed loop, one level up;
 *  - R3  a test case may not assert only that something exists;
 *  - R4  a test case may not assert only that a collaborator was called;
 *  - R5  a test case may not assert only a loose bound that any value passes;
 *  - R6  a bare `not.toThrow()` may not stand in for an assertion;
 *  - R7  a test file under `src/` must exercise a module from its own folder —
 *       a test that covers another area's code belongs to that area;
 *  - R8  an assertion may not sit inside an `if`, `else` or `catch` block — it
 *       passes without running when the branch is not taken;
 *  - R9  a test title may not say "works", "handles" or "should" — it names the
 *       condition and the outcome.
 *
 * The code under test is the module the file is named after, or the modules
 * the file imports from its own folder. Its own helpers count as part of it:
 * a test that rebuilds the expected value with a helper the subject also uses
 * proves that the helper was called with the right arguments, not that the
 * behaviour is right.
 *
 * A helper that reads the world — the filesystem, the network — is a fact, not
 * a recomputation, so it is not reported.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/** The directories the rules apply to. */
const GUARDED_ROOTS = ["src", "tests"] as const;

/** The alias the production code imports through. */
const SOURCE_ALIAS = "@/";

/** The folder the production code lives in. */
const SOURCE_ROOT = "src";

/** Matchers that assert a value. */
const VALUE_MATCHERS = [
	"toBe",
	"toEqual",
	"toStrictEqual",
	"toMatchObject",
	"toContain",
	"toContainEqual",
	"toHaveLength",
	"toHaveProperty",
	"toBeCloseTo",
	"toBeNaN",
	"toBeNull",
	"toBeUndefined",
	"toBeTruthy",
	"toBeFalsy",
	"toBeDefined",
	"toBeInstanceOf",
	"toBeTypeOf",
	"toMatch",
	"toThrow",
	"toThrowError",
	"toBeGreaterThan",
	"toBeGreaterThanOrEqual",
	"toBeLessThan",
	"toBeLessThanOrEqual",
	"toBeTrue",
	"toBeFalse",
	"toBeString",
	"toBeNumber",
	"toBeBoolean",
	"toBeBigInt",
	"toBeSymbol",
	"toBeFunction",
	"toBeObject",
	"toBeArray",
	"toBeDate",
	"toBeRegExp",
	"toBePromise",
] as const;

/** Matchers that assert how a collaborator was used, not what the system produced. */
const CALL_MATCHERS = [
	"toHaveBeenCalled",
	"toHaveBeenCalledOnce",
	"toHaveBeenCalledTimes",
	"toHaveBeenCalledWith",
	"toHaveBeenLastCalledWith",
	"toHaveBeenNthCalledWith",
	"toHaveReturned",
	"toHaveReturnedWith",
] as const;

/** Matchers that only prove something is there, or what type it has. */
const EXISTENCE_MATCHERS = [
	"toBeDefined",
	"toBeTruthy",
	"toBeFalsy",
	"toBeInstanceOf",
	"toBeTypeOf",
	"toBeString",
	"toBeNumber",
	"toBeBoolean",
	"toBeBigInt",
	"toBeSymbol",
	"toBeFunction",
	"toBeObject",
	"toBeArray",
	"toBeDate",
	"toBeRegExp",
	"toBePromise",
] as const;

/** Matchers whose bound is satisfied by any value the test could produce. */
const LOOSE_MATCHERS = ["toBeGreaterThan(0)", "toBeGreaterThanOrEqual(0)", "toBeGreaterThanOrEqual(1)"] as const;

/**
 * Accessors that read the host's detected capabilities. A test that calls one
 * of them asserts on the machine it runs on: the CI runner has a different
 * ffmpeg build, a different GPU and a different core count than the
 * developer's box. Mock the module or pass the accelerator in.
 */
const PROBE_ACCESSORS = ["getEffectiveHwaccel", "getFfmpegCapabilities", "resolveEffectiveHwaccel", "getDetectedDriDevice"] as const;

/** Helpers that read the world — their result is a fact, not a recomputation. */
const BOUNDARY_READERS = [
	"readFile",
	"readFileSync",
	"readdir",
	"readdirSync",
	"stat",
	"statSync",
	"lstat",
	"existsSync",
	"fileExists",
	"fetch",
] as const;

const LITERAL_PATTERN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const TEST_CASE_PATTERN = /\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*(?:`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
const ASSERTION_PATTERN =
	/\.(not\.)?(toBeTrue|toBeFalse|toBeString|toBeNumber|toBeBoolean|toBeBigInt|toBeSymbol|toBeFunction|toBeObject|toBeArray|toBeDate|toBeRegExp|toBePromise|toBeGreaterThanOrEqual|toBeGreaterThan|toBeLessThanOrEqual|toBeLessThan|toBe|toEqual|toStrictEqual|toMatchObject|toContain|toContainEqual|toHaveLength|toHaveProperty|toBeCloseTo|toBeNaN|toBeNull|toBeUndefined|toBeTruthy|toBeFalsy|toBeDefined|toBeInstanceOf|toBeTypeOf|toMatch\w*|toThrow\w*|toHaveBeenCalled\w*|toHaveReturned\w*|resolves\.toBe\w*|rejects\.toBe\w*|rejects\.toMatchObject)\s*\(/g;
const PRODUCTION_IMPORT_PATTERN = /(?:import\s*\{([^}]*)\}\s*from\s*|import\s*\(\s*)"([^"]+)"/g;
const IMPORTED_MODULE_PATTERN = /(?:from\s*|import\s*\(\s*)"([^"]+)"/g;
const EXPORTED_NAME_PATTERN = /export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/g;
const EXPORTED_CONSTANT_PATTERN = /export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/g;
// Only module-level constants: a constant declared inside a test case is the
// value under test, not an expectation.
const CONSTANT_PATTERN = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]+)/gm;
const IDENTIFIER_PATTERN = /\b([A-Za-z_$][\w$]*)\b/g;
const PROPERTY_NAME_PATTERN = /\.\s*([A-Za-z_$][\w$]*)/g;
const NEW_BEFORE_NAME = /\bnew\s+$/;
const ALIAS_SEPARATOR = /\s+as\s+/;
const TS_EXTENSION = /\.ts$/;
const RESOLVES_PREFIX = /^resolves\./;
const REJECTS_PREFIX = /^rejects\./;
const THROW_MATCHER = /^not\.toThrow|^toThrow/;
const CONDITIONAL_KEYWORD_PATTERN = /\b(?:if|else|catch|try)\b/g;
const CATCH_AFTER_BLOCK_PATTERN = /^\s*catch\b/;
const BAD_TITLE_PATTERN = /\b(?:works|handles|should)\b/i;
const WHITESPACE_PATTERN = /\s/;

interface Finding {
	/** The file and the line the problem sits on, as one location string. */
	file: string;
	problem: string;
}

interface TestCase {
	title: string;
	line: number;
	body: string;
}

interface Assertion {
	matcher: string;
	expected: string;
	line: number;
	/** Offset of the matcher within the case body, for block membership. */
	offset: number;
	negated: boolean;
}

/** Blanks out string and template contents so a scan never reads a literal as code. */
function maskLiterals(source: string): string {
	return source.replaceAll(LITERAL_PATTERN, (literal) => literal.replaceAll(/[^\n]/g, " "));
}

/** The balanced group that starts at `start`, which must point at an opening bracket. */
function balancedGroup(source: string, start: number): string {
	let depth = 0;
	for (let index = start; index < source.length; index++) {
		const character = source[index];
		if (character === "(" || character === "[" || character === "{") depth++;
		else if (character === ")" || character === "]" || character === "}") {
			depth--;
			if (depth === 0) return source.slice(start + 1, index);
		}
	}
	return source.slice(start + 1);
}

/** The test cases in a file, with the body of each callback. */
function readTestCases(source: string): TestCase[] {
	const cases: TestCase[] = [];
	const pattern = new RegExp(TEST_CASE_PATTERN.source, "g");
	let match = pattern.exec(source);
	while (match !== null) {
		const title = match[1] ?? match[2] ?? match[3] ?? "";
		const line = source.slice(0, match.index).split("\n").length;
		const opening = source.indexOf("{", match.index + match[0].length);
		const body = opening === -1 ? "" : balancedGroup(source, opening);
		cases.push({ title, line, body });
		match = pattern.exec(source);
	}
	return cases;
}

/** Every assertion in a body, with the matcher and the expected side. */
function readAssertions(body: string): Assertion[] {
	const assertions: Assertion[] = [];
	const pattern = new RegExp(ASSERTION_PATTERN.source, "g");
	let match = pattern.exec(body);
	while (match !== null) {
		const opening = match.index + match[0].length - 1;
		const expected = balancedGroup(body, opening);
		const line = body.slice(0, match.index).split("\n").length;
		assertions.push({ matcher: match[2] ?? "", expected, line, offset: match.index, negated: match[1] !== undefined });
		match = pattern.exec(body);
	}
	return assertions;
}

function skipWhitespace(source: string, from: number): number {
	let index = from;
	while (index < source.length && WHITESPACE_PATTERN.test(source[index] ?? "")) index++;
	return index;
}

/** The brace block a keyword introduces, after an optional `( … )` condition. */
function blockAfterKeyword(masked: string, from: number): [number, number] | undefined {
	let index = skipWhitespace(masked, from);
	if (masked[index] === "(") index = skipWhitespace(masked, index + balancedGroup(masked, index).length + 2);
	if (masked[index] !== "{") return undefined;
	return [index, index + balancedGroup(masked, index).length + 1];
}

/** A `try` block hides its failures only when a `catch` clause follows it; `try … finally` does not. */
function isGuardingBlock(keyword: string, masked: string, block: [number, number]): boolean {
	if (keyword !== "try") return true;
	return CATCH_AFTER_BLOCK_PATTERN.test(masked.slice(block[1] + 1));
}

/** The `if`, `else`, `catch` and swallowing `try` blocks of a case body, as [open, close] offsets. */
function conditionalBlocks(body: string): Array<[number, number]> {
	const masked = maskLiterals(body);
	const blocks: Array<[number, number]> = [];
	const pattern = new RegExp(CONDITIONAL_KEYWORD_PATTERN.source, "g");
	let match = pattern.exec(masked);
	while (match !== null) {
		const block = blockAfterKeyword(masked, match.index + match[0].length);
		if (block !== undefined && isGuardingBlock(match[0], masked, block)) blocks.push(block);
		match = pattern.exec(masked);
	}
	return blocks;
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

/** The names a file imports from production modules, with the module they come from. */
function readProductionImports(source: string, directory: string): Map<string, string> {
	const names = new Map<string, string>();
	const pattern = new RegExp(PRODUCTION_IMPORT_PATTERN.source, "g");
	let match = pattern.exec(source);
	while (match !== null) {
		const resolved = resolveProductionModule(match[2] ?? "", directory);
		if (resolved !== undefined) {
			for (const raw of (match[1] ?? "").split(",")) {
				const name = raw.trim().split(ALIAS_SEPARATOR).pop()?.trim();
				if (name) names.set(name, resolved);
			}
		}
		match = pattern.exec(source);
	}
	return names;
}

/** Every production module a file imports, static or dynamic. */
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

/** The functions and constants a module exports. */
function readExportedNames(source: string): Set<string> {
	const names = new Set<string>();
	const pattern = new RegExp(EXPORTED_NAME_PATTERN.source, "g");
	let match = pattern.exec(source);
	while (match !== null) {
		names.add(match[1] ?? "");
		match = pattern.exec(source);
	}
	return names;
}

/** The constants a module exports — a value the subject itself defines. */
function readExportedConstants(source: string): Set<string> {
	const names = new Set<string>();
	const pattern = new RegExp(EXPORTED_CONSTANT_PATTERN.source, "g");
	let match = pattern.exec(source);
	while (match !== null) {
		names.add(match[1] ?? "");
		match = pattern.exec(source);
	}
	return names;
}

/** The helpers of the code under test, transitively. */
function readHelperNames(subject: string, seen = new Set<string>()): Set<string> {
	if (seen.has(subject)) return new Set();
	seen.add(subject);
	const source = readFileSync(subject, "utf8");
	const names = new Set(readProductionImports(source, dirname(subject)).keys());
	for (const [, module] of readProductionImports(source, dirname(subject))) {
		for (const nested of readHelperNames(module, seen)) names.add(nested);
	}
	return names;
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

/** The constants a file declares, with the text they are built from. */
function readConstants(source: string): Map<string, string> {
	const constants = new Map<string, string>();
	const pattern = new RegExp(CONSTANT_PATTERN.source, "g");
	let match = pattern.exec(source);
	while (match !== null) {
		const name = match[1] ?? "";
		const initializer = match[2] ?? "";
		if (!constants.has(name)) constants.set(name, initializer);
		match = pattern.exec(source);
	}
	return constants;
}

/** The calls in a piece of text to the given names, ignoring constructions. */
function findCalls(text: string, names: Set<string>): string[] {
	const masked = maskLiterals(text);
	const calls: string[] = [];
	for (const name of names) {
		const pattern = new RegExp(`(^|[^.\\w$])(${name.replaceAll(/[$]/g, String.raw`\$`)})\\s*\\(`, "g");
		let match = pattern.exec(masked);
		while (match !== null) {
			const nameStart = match.index + (match[1] ?? "").length;
			const before = masked.slice(Math.max(0, nameStart - 6), nameStart);
			if (!NEW_BEFORE_NAME.test(before)) calls.push(name);
			match = pattern.exec(masked);
		}
	}
	return [...new Set(calls)];
}

/** The identifiers an expected side reads, without the property names. */
function readIdentifiers(expected: string): string[] {
	const masked = maskLiterals(expected).replaceAll(PROPERTY_NAME_PATTERN, ".$1");
	const identifiers = new Set<string>();
	const pattern = new RegExp(IDENTIFIER_PATTERN.source, "g");
	let match = pattern.exec(masked);
	while (match !== null) {
		identifiers.add(match[1] ?? "");
		match = pattern.exec(masked);
	}
	return [...identifiers];
}

/** The matcher of an assertion, without the `resolves.` or `rejects.` prefix. */
function baseMatcher(matcher: string): string {
	return matcher.replace(RESOLVES_PREFIX, "").replace(REJECTS_PREFIX, "");
}

/** The structural problems a case can have, when it has one. */
type StructuralProblem =
	| "only asserts that a collaborator was called"
	| "has no value assertion"
	| "only asserts that something exists"
	| "only asserts a bound any value passes";

/** The structural problem of a case, when it has one. */
function readStructuralProblem(assertions: Assertion[]): StructuralProblem | undefined {
	const values = assertions.filter((assertion) => (VALUE_MATCHERS as readonly string[]).includes(baseMatcher(assertion.matcher)));
	const calls = assertions.filter((assertion) => (CALL_MATCHERS as readonly string[]).includes(baseMatcher(assertion.matcher)));
	if (values.length === 0 && calls.length > 0) return "only asserts that a collaborator was called";
	if (values.length === 0) return "has no value assertion";
	const existenceOnly = values.every((assertion) => (EXISTENCE_MATCHERS as readonly string[]).includes(baseMatcher(assertion.matcher)));
	if (existenceOnly) return "only asserts that something exists";
	const looseOnly = values.every((assertion) =>
		(LOOSE_MATCHERS as readonly string[]).includes(`${baseMatcher(assertion.matcher)}(${assertion.expected.trim()})`),
	);
	if (looseOnly) return "only asserts a bound any value passes";
	return undefined;
}

/** Everything the expectation rules need to know about the code under test. */
interface ExpectationContext {
	subjectFunctions: Set<string>;
	helperFunctions: Set<string>;
	subjectConstants: Set<string>;
	constants: Map<string, string>;
}

/** The findings of one test case. */
function scanTestCase(file: string, testCase: TestCase, context: ExpectationContext): Finding[] {
	const findings: Finding[] = [];
	const assertions = readAssertions(testCase.body);
	const location = `${file}:${testCase.line}`;
	if (BAD_TITLE_PATTERN.test(testCase.title)) {
		findings.push({
			file: location,
			problem: `the title "${testCase.title}" says works, handles or should — name the condition and the outcome`,
		});
	}
	if (assertions.length === 0) {
		findings.push({ file: location, problem: `test case "${testCase.title}" has no assertion` });
		return findings;
	}
	const structural = readStructuralProblem(assertions);
	if (structural !== undefined) {
		findings.push({ file: location, problem: `test case "${testCase.title}" ${structural}` });
		return findings;
	}
	findings.push(...scanConditionalAssertions(file, testCase, assertions));
	findings.push(...scanExpectations(file, testCase, assertions, context));
	findings.push(...scanBareThrows(file, testCase, assertions));
	return findings;
}

/** The findings of assertions inside a conditional block, which pass when the branch does not run. */
function scanConditionalAssertions(file: string, testCase: TestCase, assertions: Assertion[]): Finding[] {
	const blocks = conditionalBlocks(testCase.body);
	return assertions
		.filter((assertion) => blocks.some(([open, close]) => assertion.offset > open && assertion.offset < close))
		.map((assertion) => ({
			file: `${file}:${testCase.line + assertion.line}`,
			problem: `an assertion of "${testCase.title}" sits inside an if, else, catch or try-with-catch block — it passes when the branch does not run or the failure is caught`,
		}));
}

/** The findings of the expected side of a case. */
function scanExpectations(file: string, testCase: TestCase, assertions: Assertion[], context: ExpectationContext): Finding[] {
	const findings: Finding[] = [];
	for (const assertion of assertions) {
		if (assertion.negated) continue;
		if (!(VALUE_MATCHERS as readonly string[]).includes(baseMatcher(assertion.matcher))) continue;
		const location = `${file}:${testCase.line + assertion.line}`;
		const calls = findCalls(assertion.expected, context.subjectFunctions);
		if (calls.length > 0) {
			findings.push({
				file: location,
				problem: `the expected value of "${testCase.title}" is computed with ${calls.map((name) => `${name}()`).join(", ")} — assert a literal instead`,
			});
			continue;
		}
		findings.push(...scanSubjectConstants(location, testCase, assertion, context));
		findings.push(...scanConstantExpectations(location, testCase, assertion, context));
	}
	return findings;
}

/** The findings of an expected value that is a constant the subject defines. */
function scanSubjectConstants(location: string, testCase: TestCase, assertion: Assertion, context: ExpectationContext): Finding[] {
	const findings: Finding[] = [];
	for (const identifier of readIdentifiers(assertion.expected)) {
		if (!context.subjectConstants.has(identifier)) continue;
		findings.push({
			file: location,
			problem: `the expected value of "${testCase.title}" is ${identifier}, a constant the code under test defines — assert the literal`,
		});
	}
	return findings;
}

/** The findings of a constant that builds the expected value. */
function scanConstantExpectations(location: string, testCase: TestCase, assertion: Assertion, context: ExpectationContext): Finding[] {
	const findings: Finding[] = [];
	for (const identifier of readIdentifiers(assertion.expected)) {
		const initializer = context.constants.get(identifier);
		if (initializer === undefined) continue;
		const calls = findCalls(initializer, context.subjectFunctions);
		if (calls.length === 0) continue;
		findings.push({
			file: location,
			problem: `the expected value of "${testCase.title}" is the constant ${identifier}, which is built with ${calls.map((name) => `${name}()`).join(", ")} — a helper the code under test also uses`,
		});
	}
	return findings;
}

/** The findings of a bare throw assertion. */
function scanBareThrows(file: string, testCase: TestCase, assertions: Assertion[]): Finding[] {
	const findings: Finding[] = [];
	for (const assertion of assertions) {
		if (!THROW_MATCHER.test(assertion.matcher)) continue;
		if (assertion.expected.trim() !== "") continue;
		findings.push({ file: `${file}:${testCase.line + assertion.line}`, problem: "a bare toThrow() accepts any error — assert the code" });
	}
	return findings;
}

/** The findings of one test file. */
function scanTestFile(file: string, source: string): Finding[] {
	const findings: Finding[] = [];
	const subjectModules = readSubjectModules(file, source);
	const subjectFunctions = new Set<string>();
	for (const module of subjectModules) {
		for (const name of readExportedNames(readFileSync(module, "utf8"))) subjectFunctions.add(name);
	}
	const helperFunctions = new Set<string>();
	for (const module of subjectModules) {
		for (const name of readHelperNames(module)) helperFunctions.add(name);
	}
	for (const name of BOUNDARY_READERS) {
		subjectFunctions.delete(name);
		helperFunctions.delete(name);
	}
	const subjectConstants = new Set<string>();
	for (const module of subjectModules) {
		for (const name of readExportedConstants(readFileSync(module, "utf8"))) subjectConstants.add(name);
	}
	const context: ExpectationContext = {
		subjectFunctions,
		helperFunctions,
		subjectConstants,
		constants: readConstants(source),
	};
	for (const testCase of readTestCases(source)) {
		findings.push(...scanTestCase(file, testCase, context));
	}
	return findings;
}

/** Every production file under the source root. */
function collectProductionFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules" || entry === "dist" || entry === "build") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) files.push(...collectProductionFiles(path));
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

/** The module that declares a name, found by scanning the production tree. */
function findDeclaringModule(name: string): string | undefined {
	const pattern = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`);
	for (const file of collectProductionFiles(SOURCE_ROOT)) {
		if (pattern.test(readFileSync(file, "utf8"))) return file;
	}
	return undefined;
}

/** The alias a module is imported through. */
function aliasOf(module: string): string {
	return `${SOURCE_ALIAS}${relative(SOURCE_ROOT, module).replace(TS_EXTENSION, "")}`;
}

/** Whether a file replaces a module with a mock, rather than merely importing it. */
function mocksModule(source: string, module: string): boolean {
	const alias = aliasOf(module);
	const relativePath = relative(".", module);
	const pattern = new RegExp(`mockModule\\w*\\(\\s*"(?:${alias}|${relativePath})"`);
	return pattern.test(source);
}

/**
 * The findings of the probe rule: a test must not read the host's detected
 * capabilities. The owner's own test may — it is the module under test there.
 */
function scanProbeDependency(file: string, source: string): Finding[] {
	const findings: Finding[] = [];
	const testBase = basename(file).replace(".test.ts", "");
	for (const name of PROBE_ACCESSORS) {
		if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
		const owner = findDeclaringModule(name);
		if (owner === undefined) continue;
		if (basename(owner).replace(".ts", "") === testBase) continue;
		if (mocksModule(source, owner)) continue;
		findings.push({
			file,
			problem: `the test calls ${name}() — the host's detected capabilities. Mock the module or pass the accelerator in.`,
		});
	}
	return findings;
}

/** The findings of the ownership rule: a test file must exercise its own folder. */
function scanOwnership(file: string, source: string): Finding[] {
	const relativePath = file.replace(`${SOURCE_ROOT}/`, "");
	if (relativePath.startsWith("tests/")) return [];
	const directory = dirname(file);
	const ownFolder = relative(".", directory);
	const touchesOwnFolder = readImportedModules(source, directory).some((module) => {
		const moduleFolder = dirname(module);
		return moduleFolder === ownFolder || moduleFolder.startsWith(`${ownFolder}/`);
	});
	if (touchesOwnFolder) return [];
	return [{ file, problem: "the file exercises no module from its own folder — it belongs to the folder of the code it covers" }];
}

/** Every test file under the guarded roots. */
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

function main(): void {
	const findings: Finding[] = [];
	for (const root of GUARDED_ROOTS) {
		for (const file of collectTestFiles(root)) {
			const source = readFileSync(file, "utf8");
			findings.push(...scanTestFile(file, source), ...scanOwnership(file, source), ...scanProbeDependency(file, source));
		}
	}

	if (findings.length === 0) {
		console.log("Test quality: every test case asserts a fact, not a recomputation of the code under test.");
		return;
	}

	for (const finding of findings) console.error(`${finding.file}: ${finding.problem}`);
	console.error(`\n${findings.length} test quality violation(s). Fix the assertion, not the rule.`);
	process.exit(1);
}

main();

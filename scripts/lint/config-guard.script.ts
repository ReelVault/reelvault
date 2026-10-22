/**
 * `bun run lint guard` — fails when a rule that the project depends on is
 * quietly switched off.
 *
 * The linters can only enforce what their configuration says. AGENTS.md
 * promises a few things that no linter ships a rule for, so they are checked
 * here instead:
 *
 *  - no suppression comments (`biome-ignore`, `oxlint-disable`, `@ts-expect-error`,
 *    `@ts-expect-error`, `@ts-nocheck`) — a suppressed diagnostic is a hidden
 *    defect, and the fix belongs in the model, not in a comment;
 *  - no environment-gated test skips — a test that cannot run fails loudly;
 *  - no host resource reads outside `system-resources` — CPU and RAM budgets
 *    must have one source;
 *  - no new `ignores` / `ignorePatterns` entries and no knip `ignore` entries
 *    — an ignore list is where dead code goes to hide;
 *  - no `@public` tags — knip reports unused exports, and `@public` would
 *    silence that;
 *  - the TypeScript strictness flags stay on;
 *  - the rules the quality contract depends on keep their severity, in the
 *    root rule map and in every scoped override;
 *  - the Biome grit plugins stay registered.
 */

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@/utils/type.utils";

/** The directories the guards apply to. */
const GUARDED_ROOTS = ["src", "tests", "scripts", "packages"] as const;

/** Files that are never scanned. */
const SKIPPED_FILES = new Set(["routeTree.gen.ts"]);

/**
 * The guard names the markers it looks for, so it would flag its own
 * documentation. It is the only file that is exempt.
 */
const GUARD_SCRIPT_PATH = "scripts/lint/config-guard.script.ts";

/** Comment markers that silence a diagnostic. */
const SUPPRESSION_PATTERNS = [
	{ marker: "biome-ignore", label: "biome-ignore" },
	{ marker: "oxlint-disable", label: "oxlint-disable" },
	{ marker: "eslint-disable", label: "eslint-disable" },
	{ marker: "@ts-ignore", label: "@ts-ignore" },
	{ marker: "@ts-expect-error", label: "@ts-expect-error" },
	{ marker: "@ts-nocheck", label: "@ts-nocheck" },
] as const;

/**
 * A test that is skipped by a runtime condition never protects anything.
 * Biome's `noSkippedTests` covers the static forms; this one covers the
 * dynamic form, which no linter ships a rule for.
 */
const CONDITIONAL_TEST_SKIP = /\b(?:test|it|describe)\.skipIf\s*\(/;

/** The ignore lists the project is allowed to have. */
const ALLOWED_BIOME_IGNORES = new Set([
	"**",
	"!node_modules",
	"!.agents",
	"!dist",
	"!build",
	"!**/*.svg",
	"!**/routeTree.gen.ts",
	"!**/*.gen.ts",
]);

const ALLOWED_OXLINT_IGNORES = new Set(["dist", "build", "node_modules", ".agents", "**/routeTree.gen.ts", "**/*.gen.ts"]);

/** TypeScript flags that must stay on for the code to mean what it says. */
const REQUIRED_TSCONFIG_FLAGS = [
	"strict",
	"exactOptionalPropertyTypes",
	"noUncheckedIndexedAccess",
	"noImplicitReturns",
	"noFallthroughCasesInSwitch",
	"noImplicitOverride",
	"verbatimModuleSyntax",
	"isolatedModules",
] as const;

/** TypeScript flags that must stay off — unreachable code is a defect, not a warning. */
const FORBIDDEN_TSCONFIG_FLAGS = ["allowUnreachableCode", "allowUnusedLabels"] as const;

/**
 * Host resource reads. CPU and RAM budgets are derived from
 * `system-resources.service`, never from a second, disagreeing source.
 * `tmpdir` and `homedir` are plain paths and stay allowed.
 */
const HOST_RESOURCE_FUNCTIONS: ReadonlySet<string> = new Set(["cpus", "totalmem", "freemem", "loadavg", "availableParallelism"]);

/**
 * The only files allowed to read the host directly. The benchmark scripts
 * measure the host, so they are allowed to ask it about its size.
 */
const HOST_RESOURCE_READERS = [
	"src/config/system-resources/",
	"src/system/resource-allocator/",
	"scripts/benchmark.script.ts",
	"scripts/benchmarks/",
] as const;

/** Named imports from the `os` module — the aliased form is included. */
const OS_NAMED_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*"(?:node:)?os"/;

/** A default or namespace import of the `os` module — the whole module is in scope. */
const OS_WHOLE_MODULE_IMPORT = /\bimport\s+(?:\*\s+as\s+[\w$]+|[\w$]+)\s+from\s*"(?:node:)?os"/;

/** A dynamic `require("node:os")` or `await import("node:os")`. */
const OS_DYNAMIC_IMPORT = /\b(?:require|import)\s*\(\s*"(?:node:)?os"\s*\)/;

/** The `as` in an aliased import — `cpus as c` names the same function. */
const IMPORT_ALIAS_SEPARATOR = /\s+as\s+/;

/** The Biome grit plugins the project's readability rules depend on. */
const REQUIRED_BIOME_PLUGINS = [
	"./scripts/lint/long-ternary.grit",
	"./scripts/lint/else-if-chain.grit",
	"./scripts/lint/no-namespace-object.grit",
	"./scripts/lint/no-todo-test.grit",
	"./scripts/lint/no-lost-error-cause.grit",
] as const;

/** A lint severity, from the weakest to the strongest. */
type Severity = "off" | "warn" | "error";

/**
 * A rule the project's quality contract depends on.
 *
 * The severity is the weakest level the rule may have anywhere it is
 * configured. The relaxation names the one reason a scoped override may
 * switch it off; a rule without one may never be switched off anywhere.
 */
interface RuleContract {
	/** The rule id — `group/rule` for Biome, `plugin/rule` for oxlint. */
	id: string;
	/** The weakest severity the rule may have where it is configured. */
	severity: Severity;
	/** The reason a scoped override may switch the rule off. */
	relaxation?: string;
}

/** The severity order — a weaker severity than the contract is a violation. */
const SEVERITY_RANK: Record<Severity, number> = { off: 0, warn: 1, error: 2 };

/** The severity names a linter configuration may use. */
const SEVERITIES: ReadonlySet<string> = new Set(["off", "warn", "error"]);

/** Whether a string is one of the severities a linter configuration may use. */
function isSeverity(value: string): value is Severity {
	return SEVERITIES.has(value);
}

/** A severity read from a configuration, or undefined when it is not one. */
function toSeverity(value: unknown): Severity | undefined {
	if (typeof value !== "string") return undefined;
	return isSeverity(value) ? value : undefined;
}

const BIOME_RULE_CONTRACTS: RuleContract[] = [
	{ id: "complexity/noExcessiveCognitiveComplexity", severity: "error" },
	{ id: "complexity/noExcessiveLinesPerFunction", severity: "error" },
	{ id: "complexity/useMaxParams", severity: "error" },
	{ id: "complexity/noForEach", severity: "error" },
	{ id: "complexity/noVoid", severity: "error" },
	{ id: "correctness/noUnusedImports", severity: "error" },
	{ id: "correctness/noUnusedVariables", severity: "error" },
	{ id: "correctness/noUnusedFunctionParameters", severity: "error" },
	{ id: "performance/noBarrelFile", severity: "error", relaxation: "the benchkit is a published package with a public barrel" },
	{ id: "performance/noReExportAll", severity: "error", relaxation: "the benchkit is a published package with a public barrel" },
	{ id: "suspicious/noSkippedTests", severity: "error" },
	{ id: "suspicious/noFocusedTests", severity: "error" },
	{ id: "style/noExcessiveLinesPerFile", severity: "error" },
	{ id: "style/noDefaultExport", severity: "error", relaxation: "config files need a default export" },
	{ id: "style/noNonNullAssertion", severity: "error", relaxation: "tests assert non-null after a guard" },
	{ id: "suspicious/noConsole", severity: "warn", relaxation: "scripts and the benchkit are CLIs" },
	{ id: "style/useAtIndex", severity: "error" },
	{ id: "style/useForOf", severity: "error" },
	{ id: "style/noUnusedTemplateLiteral", severity: "error" },
];

const OXLINT_RULE_CONTRACTS: RuleContract[] = [
	{ id: "typescript/no-explicit-any", severity: "error", relaxation: "tests reach into untyped fixtures" },
	{ id: "typescript/no-unsafe-type-assertion", severity: "error", relaxation: "tests assert fixture shapes" },
	{ id: "typescript/no-unsafe-assignment", severity: "error", relaxation: "tests assign fixture shapes" },
	{ id: "typescript/no-unsafe-call", severity: "error", relaxation: "tests call untyped fixtures" },
	{ id: "typescript/no-unsafe-argument", severity: "error", relaxation: "tests pass untyped fixtures" },
	{ id: "typescript/no-unsafe-member-access", severity: "error", relaxation: "tests read untyped fixtures" },
	{ id: "typescript/no-unsafe-return", severity: "error", relaxation: "tests return untyped fixtures" },
	{ id: "typescript/no-floating-promises", severity: "error" },
	{ id: "typescript/no-misused-promises", severity: "error" },
	{ id: "typescript/await-thenable", severity: "error", relaxation: "tests await a non-promise on purpose" },
	{ id: "typescript/no-unnecessary-condition", severity: "error", relaxation: "tests assert impossible branches on purpose" },
	{ id: "typescript/switch-exhaustiveness-check", severity: "error" },
	{ id: "typescript/unbound-method", severity: "error", relaxation: "tests spy on methods" },
	{ id: "typescript/array-type", severity: "error" },
	{ id: "typescript/require-array-sort-compare", severity: "error" },
	{ id: "typescript/no-namespace", severity: "error" },
	{ id: "typescript/no-for-in-array", severity: "error" },
	{ id: "eslint/eqeqeq", severity: "error" },
	{ id: "eslint/max-depth", severity: "error" },
	{ id: "eslint/no-negated-condition", severity: "error" },
	{ id: "eslint/preserve-caught-error", severity: "error" },
	{ id: "eslint/no-warning-comments", severity: "error" },
	{ id: "eslint/no-new-wrappers", severity: "error" },
	{ id: "import/no-cycle", severity: "error" },
	{ id: "import/no-duplicates", severity: "error" },
	{ id: "import/no-relative-parent-imports", severity: "error", relaxation: "tests import helpers from the parent folder" },
	{ id: "promise/no-nesting", severity: "error" },
	{ id: "promise/prefer-await-to-then", severity: "error", relaxation: "tests assert on promise rejections" },
	{ id: "unicorn/no-array-for-each", severity: "error" },
	{ id: "unicorn/no-array-reduce", severity: "error" },
	{ id: "unicorn/consistent-function-scoping", severity: "error", relaxation: "tests declare helpers inside the suite" },
	{ id: "unicorn/custom-error-definition", severity: "error" },
	{ id: "node/no-process-env", severity: "error", relaxation: "config and scripts read the environment" },
	{ id: "vitest/no-focused-tests", severity: "error" },
	{ id: "vitest/no-disabled-tests", severity: "error" },
	{ id: "vitest/expect-expect", severity: "error" },
];

interface Finding {
	file: string;
	problem: string;
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTypeScriptFiles(path)));
			continue;
		}
		if (!(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) continue;
		if (SKIPPED_FILES.has(entry.name)) continue;
		files.push(path);
	}

	return files;
}

/**
 * The problems one file has: suppression comments, `@public` tags and
 * environment-gated test skips.
 *
 * Every line is scanned, not only the ones that look like a comment: a
 * trailing `// biome-ignore` on a code line is the most common form, and it
 * is exactly the one a comment-shaped scan would miss.
 */
function scanFileForSuppressions(file: string, content: string): Finding[] {
	const findings: Finding[] = [];

	for (const [index, line] of content.split("\n").entries()) {
		const trimmed = line.trim();
		const location = `${file}:${index + 1}`;

		for (const { marker, label } of SUPPRESSION_PATTERNS) {
			if (trimmed.includes(marker)) {
				findings.push({ file: location, problem: `suppression comment (${label})` });
			}
		}
		if (trimmed.includes("@public")) {
			findings.push({ file: location, problem: "@public tag" });
		}
		if (CONDITIONAL_TEST_SKIP.test(trimmed)) {
			findings.push({ file: location, problem: "environment-gated test skip" });
		}
	}

	return findings;
}

/** The host resource reads one file makes. */
function scanFileForHostResources(file: string, content: string): Finding[] {
	const findings: Finding[] = [];

	for (const [index, line] of content.split("\n").entries()) {
		findings.push(...hostResourceFindings(file, index + 1, line));
	}

	return findings;
}

/** The host resource reads one line makes. */
function hostResourceFindings(file: string, lineNumber: number, line: string): Finding[] {
	const findings: Finding[] = [];
	const location = `${file}:${lineNumber}`;

	const named = OS_NAMED_IMPORT.exec(line);
	if (named) {
		for (const entry of (named[1] ?? "").split(",")) {
			const name = importedName(entry);
			if (isHostResourceFunction(name)) {
				findings.push({ file: location, problem: `host resource read (${name})` });
			}
		}
	}

	if (OS_WHOLE_MODULE_IMPORT.test(line) || OS_DYNAMIC_IMPORT.test(line)) {
		findings.push({ file: location, problem: "host resource read (the whole os module)" });
	}

	return findings;
}

/** The imported name without its alias. */
function importedName(entry: string): string {
	const [name] = entry.split(IMPORT_ALIAS_SEPARATOR);
	return (name ?? "").trim();
}

function isHostResourceFunction(name: string): boolean {
	return HOST_RESOURCE_FUNCTIONS.has(name);
}

/** The files that may read the host directly. */
function mayReadHost(file: string): boolean {
	return HOST_RESOURCE_READERS.some((folder) => file.startsWith(folder));
}

function readFileSyncText(path: string): string {
	return readFileSync(path, "utf8");
}

/** Reads a JSON file as a record; a malformed file reads as an empty record. */
function readJsonRecord(path: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(readFileSyncText(path));
	return isRecord(parsed) ? parsed : {};
}

/** The string entries of an array field, or an empty list when it is not one. */
function readStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/** Compares an ignore list with the one the project is allowed to have. */
function checkIgnoreList(file: string, actual: Set<string>, allowed: Set<string>, label: string): Finding[] {
	const findings: Finding[] = [];

	for (const entry of actual) {
		if (!allowed.has(entry)) findings.push({ file, problem: `new ${label} entry (${entry})` });
	}
	for (const entry of allowed) {
		if (!actual.has(entry)) findings.push({ file, problem: `removed ${label} entry (${entry})` });
	}

	return findings;
}

function checkIgnoreLists(): Finding[] {
	const biome = readJsonRecord("biome.json");
	const biomeFiles = biome.files;
	const biomeIgnores = new Set(
		isRecord(biomeFiles) && Array.isArray(biomeFiles.includes)
			? biomeFiles.includes.filter((entry): entry is string => typeof entry === "string")
			: [],
	);

	const oxlint = readJsonRecord(".oxlintrc.json");
	const knip = readJsonRecord("knip.json");
	const knipIgnores = readStringArray(knip, "ignore");

	return [
		...checkIgnoreList("biome.json", biomeIgnores, ALLOWED_BIOME_IGNORES, "files.includes"),
		...checkIgnoreList(".oxlintrc.json", new Set(readStringArray(oxlint, "ignorePatterns")), ALLOWED_OXLINT_IGNORES, "ignorePatterns"),
		...(knipIgnores.length > 0 ? [{ file: "knip.json", problem: `new knip ignore entry (${knipIgnores.join(", ")})` }] : []),
	];
}

/** Removes the comments from a JSONC document so a commented-out flag cannot satisfy a check. */
function stripJsonComments(text: string): string {
	return text.replaceAll(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

function checkTsconfig(): Finding[] {
	const findings: Finding[] = [];
	// The tsconfig is JSONC, so the flags are read by pattern instead of by parsing.
	const tsconfig = stripJsonComments(readFileSyncText("tsconfig.json"));

	for (const flag of REQUIRED_TSCONFIG_FLAGS) {
		if (!new RegExp(`"${flag}"\\s*:\\s*true`).test(tsconfig)) {
			findings.push({ file: "tsconfig.json", problem: `compilerOptions.${flag} is not true` });
		}
	}
	for (const flag of FORBIDDEN_TSCONFIG_FLAGS) {
		if (!new RegExp(`"${flag}"\\s*:\\s*false`).test(tsconfig)) {
			findings.push({ file: "tsconfig.json", problem: `compilerOptions.${flag} is not false` });
		}
	}

	return findings;
}

/** The grit plugins the Biome configuration registers. */
function checkBiomePlugins(): Finding[] {
	const biome = readJsonRecord("biome.json");
	const plugins = Array.isArray(biome.plugins) ? biome.plugins : [];
	const registered = new Set(
		plugins
			.map((plugin) => (isRecord(plugin) && typeof plugin.path === "string" ? plugin.path : null))
			.filter((path): path is string => path !== null),
	);

	return REQUIRED_BIOME_PLUGINS.filter((path) => !registered.has(path)).map((path) => ({
		file: "biome.json",
		problem: `the grit plugin ${path} is not registered`,
	}));
}

/** The severity of a rule entry that is a plain string or a `[severity, options]` tuple. */
function readPlainSeverity(value: unknown): Severity | undefined {
	if (typeof value === "string") return toSeverity(value);
	if (Array.isArray(value)) return toSeverity(value[0]);
	return undefined;
}

/** The severity of a Biome rule entry: a plain string or an object with `level`. */
function readBiomeSeverity(value: unknown): Severity | undefined {
	if (typeof value === "string") return toSeverity(value);
	if (isRecord(value)) return readPlainSeverity(value.level);
	return undefined;
}

/** The severity of a Biome rule in the root rule map. */
function readBiomeRootSeverity(rules: Record<string, unknown>, ruleId: string): Severity | undefined {
	const separator = ruleId.indexOf("/");
	if (separator === -1) return undefined;
	const group = rules[ruleId.slice(0, separator)];
	if (!isRecord(group)) return undefined;
	return readBiomeSeverity(group[ruleId.slice(separator + 1)]);
}

/** Every rule a Biome override mentions, with the severity it sets. */
function biomeOverrideRules(override: unknown): Array<{ id: string; severity: Severity | undefined }> {
	if (!isRecord(override)) return [];
	const linter = override.linter;
	if (!isRecord(linter)) return [];
	const rules = linter.rules;
	if (!isRecord(rules)) return [];

	const entries: Array<{ id: string; severity: Severity | undefined }> = [];
	for (const [group, groupRules] of Object.entries(rules)) {
		if (!isRecord(groupRules)) continue;
		for (const [rule, value] of Object.entries(groupRules)) {
			entries.push({ id: `${group}/${rule}`, severity: readBiomeSeverity(value) });
		}
	}
	return entries;
}

/** Every rule an oxlint override mentions, with the severity it sets. */
function oxlintOverrideRules(override: unknown): Array<{ id: string; severity: Severity | undefined }> {
	if (!isRecord(override)) return [];
	const rules = override.rules;
	if (!isRecord(rules)) return [];
	return Object.entries(rules).map(([id, value]) => ({ id, severity: readPlainSeverity(value) }));
}

/**
 * Reports a rule whose severity is weaker than the contract allows.
 *
 * The root rule map applies everywhere, so a rule there may never be
 * switched off. A scoped override may switch it off, but only when the
 * contract names the reason.
 */
function checkRuleSeverity(
	file: string,
	contract: RuleContract,
	rootSeverity: Severity | undefined,
	overrideSeverities: Array<Severity | undefined>,
): Finding[] {
	return [
		...checkRootSeverity(file, contract, rootSeverity, overrideSeverities.length),
		...checkOverrideSeverities(file, contract, overrideSeverities),
	];
}

/**
 * The root rule map applies everywhere, so a rule there may never be
 * switched off, and it may never be weaker than the contract asks for.
 */
function checkRootSeverity(file: string, contract: RuleContract, rootSeverity: Severity | undefined, overrideCount: number): Finding[] {
	const findings: Finding[] = [];

	if (rootSeverity === undefined) {
		if (overrideCount === 0) findings.push({ file, problem: `rule ${contract.id} is not configured at all` });
		return findings;
	}

	if (rootSeverity === "off") {
		findings.push({ file, problem: `rule ${contract.id} is switched off in the root rule map` });
		return findings;
	}

	const required = SEVERITY_RANK[contract.severity];
	if (SEVERITY_RANK[rootSeverity] < required) {
		findings.push({ file, problem: `rule ${contract.id} is "${rootSeverity}" but the contract requires "${contract.severity}"` });
	}

	return findings;
}

/** A scoped override may switch a rule off, but only when the contract names the reason. */
function checkOverrideSeverities(file: string, contract: RuleContract, overrideSeverities: Array<Severity | undefined>): Finding[] {
	const findings: Finding[] = [];
	const required = SEVERITY_RANK[contract.severity];

	for (const severity of overrideSeverities) {
		if (severity === undefined) continue;
		if (severity === "off") {
			if (contract.relaxation !== undefined) continue;
			findings.push({ file, problem: `rule ${contract.id} is switched off in an override` });
			continue;
		}
		if (SEVERITY_RANK[severity] >= required) continue;
		findings.push({
			file,
			problem: `rule ${contract.id} is "${severity}" in an override but the contract requires "${contract.severity}"`,
		});
	}

	return findings;
}

/** The severities every override sets, keyed by rule id. */
function collectOverrideSeverities(
	overrides: unknown[],
	readRules: (override: unknown) => Array<{ id: string; severity: Severity | undefined }>,
) {
	const severities = new Map<string, Array<Severity | undefined>>();

	for (const override of overrides) {
		for (const entry of readRules(override)) {
			const list = severities.get(entry.id) ?? [];
			list.push(entry.severity);
			severities.set(entry.id, list);
		}
	}

	return severities;
}

function checkBiomeRuleSeverities(): Finding[] {
	const biome = readJsonRecord("biome.json");
	const linter = biome.linter;
	if (!isRecord(linter)) return [{ file: "biome.json", problem: "the linter block is missing" }];

	const rules = isRecord(linter.rules) ? linter.rules : {};
	const overrides = Array.isArray(biome.overrides) ? biome.overrides : [];
	const severities = collectOverrideSeverities(overrides, biomeOverrideRules);

	const findings: Finding[] = [];
	for (const contract of BIOME_RULE_CONTRACTS) {
		findings.push(
			...checkRuleSeverity("biome.json", contract, readBiomeRootSeverity(rules, contract.id), severities.get(contract.id) ?? []),
		);
	}
	return findings;
}

function checkOxlintRuleSeverities(): Finding[] {
	const oxlint = readJsonRecord(".oxlintrc.json");
	const rules = isRecord(oxlint.rules) ? oxlint.rules : {};
	const overrides = Array.isArray(oxlint.overrides) ? oxlint.overrides : [];
	const severities = collectOverrideSeverities(overrides, oxlintOverrideRules);

	const findings: Finding[] = [];
	for (const contract of OXLINT_RULE_CONTRACTS) {
		findings.push(
			...checkRuleSeverity(".oxlintrc.json", contract, readPlainSeverity(rules[contract.id]), severities.get(contract.id) ?? []),
		);
	}
	return findings;
}

/** The rules the quality contract depends on keep their severity. */
function checkRuleSeverities(): Finding[] {
	return [...checkBiomeRuleSeverities(), ...checkOxlintRuleSeverities()];
}

async function main(): Promise<void> {
	const files: string[] = [];
	for (const root of GUARDED_ROOTS) {
		files.push(...(await collectTypeScriptFiles(root)));
	}

	const findings: Finding[] = [];
	for (const file of files) {
		if (file === GUARD_SCRIPT_PATH) continue;
		const content = await readFile(file, "utf8");
		findings.push(...scanFileForSuppressions(file, content));
		if (!mayReadHost(file)) findings.push(...scanFileForHostResources(file, content));
	}
	findings.push(...checkIgnoreLists(), ...checkTsconfig(), ...checkBiomePlugins(), ...checkRuleSeverities());

	if (findings.length === 0) {
		console.log(
			"Config guard: no suppression comments, no environment-gated test skips, no host resource reads, no new ignore entries, strict TypeScript flags intact, grit plugins registered, contract rules enabled.",
		);
		return;
	}

	for (const finding of findings) {
		console.error(`${finding.file}: ${finding.problem}`);
	}
	console.error(`\n${findings.length} guard violation(s). Fix the cause instead of silencing the linter.`);
	process.exit(1);
}

await main();

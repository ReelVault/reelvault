/**
 * `bun run lint:guard` — fails when a rule that the project depends on is
 * quietly switched off.
 *
 * The linters can only enforce what their configuration says. AGENTS.md
 * promises a few things that no linter ships a rule for, so they are checked
 * here instead:
 *
 *  - no suppression comments (`biome-ignore`, `oxlint-disable`, `@ts-expect-error`,
 *    `@ts-expect-error`, `@ts-nocheck`) — a suppressed diagnostic is a hidden
 *    defect, and the fix belongs in the model, not in a comment;
 *  - no host resource reads outside `system-resources` — CPU and RAM budgets
 *    must have one source;
 *  - no new `ignores` / `ignorePatterns` entries and no knip `ignore` entries
 *    — an ignore list is where dead code goes to hide;
 *  - no `@public` tags — knip reports unused exports, and `@public` would
 *    silence that;
 *  - the TypeScript strictness flags stay on.
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
const REQUIRED_TSCONFIG_FLAGS = ["strict", "exactOptionalPropertyTypes", "noUncheckedIndexedAccess"] as const;

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

/** An import of a host resource function. */
const HOST_RESOURCE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"(?:node:)?os"/;

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

/** The problems one file has: suppression comments and `@public` tags. */
function scanFileForSuppressions(file: string, content: string): Finding[] {
	const findings: Finding[] = [];

	for (const [index, line] of content.split("\n").entries()) {
		const trimmed = line.trim();
		const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
		if (!isComment) continue;

		for (const { marker, label } of SUPPRESSION_PATTERNS) {
			if (trimmed.includes(marker)) {
				findings.push({ file: `${file}:${index + 1}`, problem: `suppression comment (${label})` });
			}
		}
		if (trimmed.includes("@public")) {
			findings.push({ file: `${file}:${index + 1}`, problem: "@public tag" });
		}
	}

	return findings;
}

/** The host resource functions one file imports. */
function scanFileForHostResources(file: string, content: string): Finding[] {
	const findings: Finding[] = [];

	for (const [index, line] of content.split("\n").entries()) {
		const match = HOST_RESOURCE_IMPORT.exec(line);
		if (!match) continue;

		const names = (match[1] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.length > 0);
		for (const name of names) {
			if (!isHostResourceFunction(name)) continue;
			findings.push({ file: `${file}:${index + 1}`, problem: `host resource read (${name})` });
		}
	}

	return findings;
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

function checkTsconfig(): Finding[] {
	const findings: Finding[] = [];
	// The tsconfig is JSONC, so the flags are read by pattern instead of by parsing.
	const tsconfig = readFileSyncText("tsconfig.json");

	for (const flag of REQUIRED_TSCONFIG_FLAGS) {
		if (!new RegExp(`"${flag}"\\s*:\\s*true`).test(tsconfig)) {
			findings.push({ file: "tsconfig.json", problem: `compilerOptions.${flag} is not true` });
		}
	}

	return findings;
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
	findings.push(...checkIgnoreLists(), ...checkTsconfig());

	if (findings.length === 0) {
		console.log("Config guard: no suppression comments, no host resource reads, no new ignore entries, strict TypeScript flags intact.");
		return;
	}

	for (const finding of findings) {
		console.error(`${finding.file}: ${finding.problem}`);
	}
	console.error(`\n${findings.length} guard violation(s). Fix the cause instead of silencing the linter.`);
	process.exit(1);
}

await main();

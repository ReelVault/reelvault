/**
 * `bun run lint [check ...]` — every static check, side by side. A check prints one line when it
 * passes and its whole output when it fails; the run fails when any check fails, after all of them
 * have finished, so one run reports every problem. Name checks to run only those:
 * `bun run lint types tests`.
 */
import { delimiter, join } from "node:path";

interface Check {
	name: string;
	description: string;
	cmd: string[];
}

interface CheckResult {
	check: Check;
	exitCode: number;
	output: string;
	durationMs: number;
}

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "node_modules", ".bin");

const CHECKS: readonly Check[] = [
	{ name: "biome", description: "formatting, imports and the Biome rules", cmd: ["biome", "check", "--error-on-warnings"] },
	{ name: "oxlint", description: "type-aware lint rules", cmd: ["oxlint", "--type-aware", "--deny-warnings"] },
	{ name: "types", description: "TypeScript", cmd: ["tsc", "--noEmit"] },
	{ name: "deadcode", description: "unused files, exports and dependencies, import cycles (knip)", cmd: ["knip-bun"] },
	{
		name: "duplicates",
		description: "copy/paste budget over src/ (tests included) and over production code",
		cmd: [process.execPath, "scripts/lint/duplicates.script.ts"],
	},
	{ name: "tests", description: "test files that cannot catch a bug", cmd: [process.execPath, "scripts/lint/test-quality.script.ts"] },
	{
		name: "guard",
		description: "rules no linter ships (suppressions, ignores, strict flags)",
		cmd: [process.execPath, "scripts/lint/config-guard.script.ts"],
	},
	{
		name: "migrations",
		description: "schema changes without a migration",
		cmd: [process.execPath, "scripts/lint/migration-drift.script.ts"],
	},
];

/** A tool from node_modules/.bin, or the command as given (bun itself, for the repository's own scripts). */
function resolveCommand(cmd: readonly string[]): string[] {
	const [program = "", ...rest] = cmd;

	return [Bun.which(program, { PATH: BIN }) ?? program, ...rest];
}

async function runCheck(check: Check): Promise<CheckResult> {
	const startedAt = performance.now();
	const proc = Bun.spawn({
		cmd: resolveCommand(check.cmd),
		cwd: ROOT,
		// The repository's tools first on the PATH, for the checks that spawn one themselves.
		env: { ...process.env, PATH: `${BIN}${delimiter}${process.env.PATH ?? ""}`, ...(process.stdout.isTTY ? { FORCE_COLOR: "1" } : {}) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

	return { check, exitCode, output: `${stdout}${stderr}`.trimEnd(), durationMs: performance.now() - startedAt };
}

function selectChecks(names: readonly string[]): readonly Check[] {
	if (names.length === 0) return CHECKS;

	const unknown = names.filter((name) => !CHECKS.some((check) => check.name === name));
	if (unknown.length > 0) {
		console.error(
			`Unknown check: ${unknown.join(", ")}\n\nChecks:\n${CHECKS.map((check) => `  ${check.name.padEnd(18)} ${check.description}`).join("\n")}`,
		);
		process.exit(2);
	}

	return CHECKS.filter((check) => names.includes(check.name));
}

const selected = selectChecks(process.argv.slice(2));
const startedAt = performance.now();
const failures: CheckResult[] = [];
await Promise.all(
	selected.map(async (check) => {
		const result = await runCheck(check);
		const seconds = (result.durationMs / 1000).toFixed(1);
		if (result.exitCode === 0) {
			console.log(`✔ ${check.name} (${seconds}s)`);

			return;
		}

		failures.push(result);
		console.log(`✖ ${check.name} (${seconds}s)`);
	}),
);

for (const failure of failures) {
	console.log(`\n━━ ${failure.check.name}: ${failure.check.description} ━━\n${failure.output}`);
}

const total = ((performance.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
	console.error(
		`\n${failures.length} of ${selected.length} checks failed (${total}s): ${failures.map((failure) => failure.check.name).join(", ")}`,
	);
	process.exitCode = 1;
} else {
	console.log(`\nAll ${selected.length} checks passed (${total}s).`);
}

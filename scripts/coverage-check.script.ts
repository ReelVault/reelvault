/**
 * `bun run coverage` — runs the suite with coverage and fails when a test fails
 * or the production code drops below the line-coverage floor, so CI runs the
 * suite once. The floor is a guard against silent erosion, not a target: the
 * number moves with the code.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The share of production lines the suite has to cover. */
const LINE_COVERAGE_FLOOR = 75;
/** Only the server sources count; the benchmark kit and the test fixtures do not. */
const COVERED_PREFIX = "src/";

interface FileCoverage {
	file: string;
	lines: number;
	covered: number;
}

function parseLcov(lcov: string): FileCoverage[] {
	const files: FileCoverage[] = [];
	let file = "";
	let lines = 0;
	let covered = 0;

	for (const line of lcov.split("\n")) {
		if (line.startsWith("SF:")) {
			file = line.slice(3).trim();
			lines = 0;
			covered = 0;
		} else if (line.startsWith("LF:")) {
			lines = Number(line.slice(3));
		} else if (line.startsWith("LH:")) {
			covered = Number(line.slice(3));
		} else if (line.startsWith("end_of_record")) {
			files.push({ file, lines, covered });
		}
	}

	return files;
}

function productionFiles(files: readonly FileCoverage[]): FileCoverage[] {
	return files.filter((entry) => entry.file.startsWith(COVERED_PREFIX) && !entry.file.includes(".test."));
}

/** The same run as `bun run test` (parallel workers, each file isolated), with coverage on. */
async function runSuite(coverageDir: string): Promise<void> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "test", "--parallel", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${coverageDir}`],
		stdout: "ignore",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) {
		console.error("The test suite failed — coverage was not measured.");
		process.exit(code);
	}
}

async function main(): Promise<void> {
	const coverageDir = await mkdtemp(join(tmpdir(), "reelvault-coverage-"));

	try {
		await runSuite(coverageDir);
		const files = productionFiles(parseLcov(await readFile(join(coverageDir, "lcov.info"), "utf8")));
		const lines = files.reduce((total, entry) => total + entry.lines, 0);
		const covered = files.reduce((total, entry) => total + entry.covered, 0);
		const percentage = lines === 0 ? 100 : (covered / lines) * 100;
		const report = percentage.toFixed(2);

		console.log(`Line coverage of ${COVERED_PREFIX}: ${report}% (${covered}/${lines} lines in ${files.length} files)`);
		if (percentage < LINE_COVERAGE_FLOOR) {
			console.error(`Coverage ${report}% is below the ${LINE_COVERAGE_FLOOR}% floor.`);
			process.exit(1);
		}
	} finally {
		await rm(coverageDir, { recursive: true, force: true });
	}
}

await main();

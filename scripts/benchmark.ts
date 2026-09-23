import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscovery, suiteArgs } from "benchkit";

process.env.NODE_ENV = "production";

// Isolate in-process suites from the developer's real data directory. The
// module-level `databaseFactory` reads ROOT_DIR/DB_FILE_NAME at import time, so
// this must run before any suite module (and therefore the database) is loaded.
// Only ROOT_DIR is overridden: the default DB_FILE_NAME ("reelvault.sqlite") is
// what the spawned-server benchmark helper expects. Managers that spawn their own
// server set ROOT_DIR themselves.
const benchmarkRoot = mkdtempSync(join(tmpdir(), "reelvault-benchmark-"));
process.env.ROOT_DIR = benchmarkRoot;
process.on("exit", () => {
	rmSync(benchmarkRoot, { recursive: true, force: true });
});

const benchDir = join(import.meta.dir, "benchmarks");
const files = readdirSync(benchDir)
	.filter((file) => file.endsWith(".bench.ts"))
	.toSorted()
	.map((file) => join(benchDir, file));

const args = suiteArgs();

let jsonPath: string | undefined;
if (args.json === true) {
	jsonPath = "benchmark-results/benchkit-latest.json";
} else if (typeof args.json === "string") {
	jsonPath = args.json;
}

const DEFAULT_BASELINE_PATH = "benchmark-results/baseline.json";
let saveBaseline: string | undefined;
if (args.saveBaseline === true) {
	saveBaseline = DEFAULT_BASELINE_PATH;
} else if (typeof args.saveBaseline === "string") {
	saveBaseline = args.saveBaseline;
}

let compareBaseline: string | undefined;
if (args.compareBaseline === true) {
	compareBaseline = DEFAULT_BASELINE_PATH;
} else if (typeof args.compareBaseline === "string") {
	compareBaseline = args.compareBaseline;
}

await runDiscovery({
	files,
	command: "benchmark",
	// `--help` at the bootstrap level shows the list of suites instead of
	// running the selected file (a help-target file registers no units).
	target: args.help ? "help" : (args.target ?? "help"),
	only: args.only,
	jsonPath,
	saveBaseline,
	compareBaseline,
	strict: args.strict,
});

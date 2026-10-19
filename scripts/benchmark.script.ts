import { mkdtempSync, readdirSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscovery, suiteArgs } from "benchkit";
import { spawnSync, which } from "bun";

process.env.NODE_ENV = "production";

interface HardwareProfile {
	readonly cores: number;
	readonly speedFactor: number;
	readonly totalMemoryKiB: number;
	/** Small boxes have no usable hardware encoder; force FFmpeg onto the CPU. */
	readonly softwareEncoding?: boolean | undefined;
}

/**
 * Simulated hosts for runs on a fast development machine. `low-end` mirrors a
 * Raspberry Pi 4 (4 slow cores, 2 GiB), `old-laptop` a dual-core 4 GiB machine,
 * and `modern` a desktop with 8 cores and 16 GiB. The server reads the values
 * from the environment, so spawned servers and in-process suites see the same
 * budgets.
 */
const HARDWARE_PROFILES: Readonly<Record<string, HardwareProfile>> = {
	"low-end": { cores: 4, speedFactor: 0.35, totalMemoryKiB: 2 * 1024 * 1024, softwareEncoding: true },
	rpi: { cores: 4, speedFactor: 0.35, totalMemoryKiB: 2 * 1024 * 1024, softwareEncoding: true },
	"old-laptop": { cores: 2, speedFactor: 0.5, totalMemoryKiB: 4 * 1024 * 1024, softwareEncoding: true },
	modern: { cores: 8, speedFactor: 1.2, totalMemoryKiB: 16 * 1024 * 1024 },
};

function applyHardwareProfile(name: string | boolean | undefined): void {
	if (name === undefined) return;
	if (typeof name !== "string") throw new Error("--hardware needs a profile name");

	const profile = HARDWARE_PROFILES[name];
	if (!profile) {
		throw new Error(`Unknown --hardware profile "${name}". Use: ${Object.keys(HARDWARE_PROFILES).join(", ")}`);
	}

	process.env.REELVAULT_BENCH_CORES = String(profile.cores);
	process.env.REELVAULT_BENCH_SPEED_FACTOR = String(profile.speedFactor);
	process.env.REELVAULT_BENCH_TOTAL_MEMORY_KIB = String(profile.totalMemoryKiB);
	if (profile.softwareEncoding) process.env.REELVAULT_BENCH_FORCE_SOFTWARE = "true";
	else delete process.env.REELVAULT_BENCH_FORCE_SOFTWARE;

	const cpuCount = Math.min(profile.cores, availableParallelism());
	const cpuList = Array.from({ length: cpuCount }, (_, index) => index).join(",");
	let affinity = "";
	if (cpuCount < availableParallelism() && process.platform === "linux" && which("taskset")) {
		const probe = spawnSync({ cmd: ["taskset", "-c", cpuList, "true"], stdout: "ignore", stderr: "ignore" });
		if (probe.exitCode === 0) {
			process.env.REELVAULT_BENCH_CPU_AFFINITY = cpuList;
			affinity = `, server pinned to CPUs ${cpuList}`;
		}
	}

	console.log(
		`[benchmark] hardware simulation: ${name} (${profile.cores} cores, speed factor ${profile.speedFactor}, ${Math.round(profile.totalMemoryKiB / 1024)} MiB RAM${affinity}; budgets simulated, wall-clock still depends on host core speed)`,
	);
}

// Isolate in-process suites from the developer's real data directory. The
// module-level `databaseFactory` reads ROOT_DIR/DB_FILE_NAME at import time, so
// this must run before any suite module (and therefore the database) is loaded.
// Static imports hoist above these assignments, so any module reaching
// `env.config` is imported dynamically below — a static `@/` import here would
// evaluate the environment first and silently revert the run to `.env` (real
// data directory, development mode). Only ROOT_DIR is overridden: the default
// DB_FILE_NAME ("reelvault.sqlite") is what the spawned-server benchmark helper
// expects. Managers that spawn their own server set ROOT_DIR themselves.
const benchmarkRoot = mkdtempSync(join(tmpdir(), "reelvault-benchmark-"));
process.env.ROOT_DIR = benchmarkRoot;

// Honesty and hardware flags are parsed before env.config is first evaluated,
// so the process — and every spawned server, which inherits process.env — sees them.
const args = suiteArgs(new Set(["hardware"]));
applyHardwareProfile(args.flags.hardware);
if (args.noCache) process.env.REELVAULT_BENCH_DISABLE_CACHES = "true";
if (args.noDedup) process.env.REELVAULT_BENCH_DISABLE_DEDUP = "true";

const { removeTreeSync } = await import("@/utils/directory.utils");
process.on("exit", () => {
	removeTreeSync(benchmarkRoot);
});

// Fail loudly when some import captured the environment before isolation ran:
// the run would otherwise migrate, seed and measure the real database.
const { env } = await import("@/config/env.config");
if (env.ROOT_DIR !== benchmarkRoot) {
	throw new Error(`[benchmark] ROOT_DIR was captured as "${env.ROOT_DIR}" instead of "${benchmarkRoot}"`);
}
if (env.NODE_ENV !== "production") {
	throw new Error(`[benchmark] NODE_ENV was captured as "${env.NODE_ENV}" instead of "production"`);
}

const benchDir = join(import.meta.dir, "benchmarks");
const files = readdirSync(benchDir)
	.filter((file) => file.endsWith(".bench.ts"))
	.toSorted()
	.map((file) => join(benchDir, file));

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

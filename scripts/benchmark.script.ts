/**
 * `bun run benchmark <suite...> [flags]` — the one entry point of the benchmark suites
 * (scripts/benchmarks/*.bench.ts), on benchkit's command line. Without a suite it lists them;
 * `--help` lists the flags. This file adds what only ReelVault knows: an isolated data directory
 * and production mode for every run, and simulated hardware budgets (`--hardware`).
 */
import { mkdtempSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchmarkArgs, runBenchmarkCli } from "benchkit";
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

/**
 * Isolates the run from the developer's real data directory. The module-level `databaseFactory`
 * reads ROOT_DIR/DB_FILE_NAME at import time, so this runs before any suite (and therefore the
 * database) is loaded — and every `@/` module is imported dynamically here: a static import would
 * evaluate the environment first and silently point the run at `.env` (real data, development mode).
 * Spawned servers get their own ROOT_DIR.
 */
async function isolateRun(args: BenchmarkArgs): Promise<void> {
	const benchmarkRoot = mkdtempSync(join(tmpdir(), "reelvault-benchmark-"));
	process.env.ROOT_DIR = benchmarkRoot;

	// Applied before env.config is first evaluated, so this process and every spawned server see them.
	applyHardwareProfile(args.flags.hardware);
	if (args.noCache) process.env.REELVAULT_BENCH_DISABLE_CACHES = "true";
	if (args.noDedup) process.env.REELVAULT_BENCH_DISABLE_DEDUP = "true";

	const { removeTreeSync } = await import("@/utils/directory.utils");
	process.on("exit", () => {
		removeTreeSync(benchmarkRoot);
	});

	// Fail loudly when some import captured the environment before isolation ran: the run would
	// otherwise migrate, seed and measure the real database.
	const { env } = await import("@/config/env.config");
	if (env.ROOT_DIR !== benchmarkRoot) {
		throw new Error(`[benchmark] ROOT_DIR was captured as "${env.ROOT_DIR}" instead of "${benchmarkRoot}"`);
	}
	if (env.NODE_ENV !== "production") {
		throw new Error(`[benchmark] NODE_ENV was captured as "${env.NODE_ENV}" instead of "production"`);
	}
}

await runBenchmarkCli({
	suitesDir: join(import.meta.dir, "benchmarks"),
	command: "benchmark",
	extraFlags: new Set(["hardware"]),
	extraUsage: `  --hardware <profile>   simulate a host: ${Object.keys(HARDWARE_PROFILES).join(", ")} (low-end = Raspberry Pi 4)`,
	prepare: isolateRun,
});

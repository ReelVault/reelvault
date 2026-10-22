# benchkit

Benchmarks for Bun projects: micro timings, interleaved A/B comparisons with an equivalence check,
closed-loop HTTP load, baselines with significance verdicts, process RSS/CPU sampling, leak-trend
checks and CPU/heap profiling — behind one command line. Developed inside ReelVault and meant to
ship as its own package.

**Bun-first, no `@/` imports** — that is the package's hard boundary. Everything that knows a
project's schema, routes or seed data stays in the project (ReelVault: `scripts/benchmarks/lib/`).

## Setup

A project needs a folder of `*.bench.ts` suites and a five-line entry script:

```ts
// scripts/benchmark.script.ts — run as `bun run benchmark <suite...>`
import { join } from "node:path";
import { runBenchmarkCli } from "benchkit";

await runBenchmarkCli({
	suitesDir: join(import.meta.dir, "benchmarks"),
	command: "benchmark",
	// Optional: runs before any suite is imported — point the app at a temporary data directory,
	// force production mode, apply flags of your own (`extraFlags`, `extraUsage`).
	prepare: async (args) => {},
});
```

ReelVault's `scripts/benchmark.script.ts` uses `prepare` to isolate every run in its own data
directory and to simulate smaller hosts (`--hardware low-end`).

## Running

```bash
bun run benchmark                                   # list the suites with their descriptions
bun run benchmark matching database                 # several suites, in the order given
bun run benchmark all                               # every suite (gc between suites)
bun run benchmark micro --only diacritics           # only units whose name matches (regex, case-insensitive)
bun run benchmark http --concurrency 8 --duration 3000 --rows 20000
bun run benchmark query-count query-plan --strict   # the deterministic audits (CI runs these)
bun run benchmark http --hardware low-end           # simulate a Raspberry Pi 4 budget (cores, speed, RAM)
bun run benchmark http --profile                    # CPU + heap profiles of the run and of every spawned server
bun run benchmark --help                            # every flag
```

### Before/after a change

```bash
bun run benchmark matching database --save-baseline        # benchmark-results/baseline.json
# ...change the code...
bun run benchmark matching database --compare-baseline --strict
```

Every bench unit gets a verdict: **faster / slower / unchanged / noisy** — Mann-Whitney U on the raw
samples, with a 3% practical threshold. Task metrics (`data.metrics`: throughput, p95, RSS, CPU) are
one number per run, so they get a delta verdict without a significance test; repeat the run to
trust them. With `--strict` a "slower" verdict, a failed task or a failed equality check exits 1.

### Investigating

- `--profile` writes Bun's `.cpuprofile` (open in Chrome DevTools) plus a grep-friendly `.md` CPU
  and heap summary to `benchmark-results/profiles/<timestamp>/`: the benchmark process at the root
  (in-process suites), and one folder per process a suite spawns with `profilerFlags(label)` in its
  command (ReelVault's HTTP servers). Profiling slows the run; read its timings as relative.
- `--keep-server` leaves the spawned server running (its data directory and `server.log` are printed).
- `--json[=path]` writes every result, task data included (`benchmark-results/benchkit-latest.json`).
- `--no-cache` / `--no-dedup` measure the cold path and the worst case without request coalescing.

## For AI agents

Everything an agent needs is machine-readable or grep-friendly:
- `bun run benchmark` lists the suites with one-line descriptions; `--help` lists every flag.
- `--only <regex>` narrows a run to the units that matter; a pattern matching nothing exits 1.
- `--json=<path>` writes every result (`schema: "benchkit/v1"`): per bench `stats` (count, mean,
  p50/p95/p99/max) and its baseline `verdict`, per compare the variants' ns/op and the winner, per
  task its `ok` and `data`.
- `--save-baseline` then `--compare-baseline --strict` answers "did my change make it slower?" with a
  verdict per unit and an exit code.
- `--profile` writes `.md` CPU and heap profiles: hot functions by self and total time with source
  locations, ready to read without a viewer.

## Writing a suite

A suite is one file, `scripts/benchmarks/<name>.bench.ts`. Importing it registers its units; the
runner executes them. The `meta.description` is what the suite list shows.

```ts
import { bench, compare, fixture, group, suiteArgs, task } from "benchkit";

export const meta = { description: "..." };

const args = suiteArgs(); // the run's flags, parsed once per process

group("Matching (sync, per call)", () => {
	bench("rankCandidates", ({ iteration }) => rankCandidates(windows[iteration % windows.length], query, 2015));
});

// Variants must produce the same output, or no winner is declared.
compare("stripDiacritics", { variants: { NFD: stripNfd, map: stripMap }, equal: (a, b) => a === b, batch: 32 });

const server = fixture("server", async ({ onCleanup }) => {
	const managed = await startBenchmarkServer({ seedRows: args.rows });
	onCleanup(() => managed.stop());

	return managed;
});

task("http: browse", async () => {
	const results = await runScenarioMatrix({ suite: "http", unit: "req/s", scenarios, ...args });
	printHttpResults(results);

	return { ok: true, data: { metrics: httpScenarioMetrics(results) } }; // baseline-comparable
});
```

- `bench()` — per-iteration timing (warmup, then `--iterations` samples); one table per `group`.
  A bench that returns an array reports its length as `rows`.
- `compare()` — A/B over variants of one operation. Variants run in interleaved rounds with a
  rotating order, so drift (JIT tiers, thermal throttling, GC) hits all of them alike; each timing
  covers `batch` calls and the result is the median ns per call, with each variant's factor
  against the fastest.
- `task()` — anything else: load flows, audits, phase sequences. It prints its own tables and returns
  `{ ok, data }`; `ok: false` is a failure under `--strict`, `data.metrics` joins the baseline.
- `fixture()` — lazy and shared within a file; cleanups run in reverse order when the file ends,
  even after an error.

Task names follow `"<suite>: <phase>"`, so `--only` targets them unambiguously.

## Modules

| File                | Role                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.runner.ts`     | `runBenchmarkCli` (the command line: suite discovery, `--profile` re-run, result paths, `prepare`), `profilerFlags` for spawned Bun processes                                    |
| `args.parser.ts`    | the flags and `suiteArgs()` (one parse per process)                                                                                                                              |
| `bench.registry.ts` | `group`/`bench`/`compare`/`task`/`fixture` and unit collection                                                                                                                   |
| `bench.runner.ts`   | suite listing and selection, execution, `--json`, baselines, `--strict`                                                                                                          |
| `micro.utils.ts`    | `measure`/`measureAsync`, `benchmark`/`benchmarkAsync` (with row counts), `printMicroResults`                                                                                    |
| `compare.utils.ts`  | `compareVariants` (interleaved A/B with the equality check), `printAbResult`                                                                                                     |
| `scenario.utils.ts` | HTTP load scenarios: `runScenarioMatrix`, `runRequestScenario`, `toScenarioEntries`, `toScenarioResult`, `printHttpResults`, `httpScenarioMetrics`, `jsonRequest`, `stringField` |
| `load.utils.ts`     | `runLoadWindow` (the closed-loop window with warmup), `weightedMix`, `identityIndexFor`, `subnetIp`, `parseSegments`                                                             |
| `task.recorder.ts`  | `Recorder`: per-operation latencies and errors for mixed-load tasks, `recorder.time()`                                                                                           |
| `rss.utils.ts`      | RSS and CPU time from `/proc`: `startProcessSampler`, `startRssSampler`, `startCpuSampler`                                                                                       |
| `trend.utils.ts`    | `growthVerdict`, `linearSlope`, `levelsOff` — the leak test for a process whose GC cannot be forced                                                                              |
| `latency.utils.ts`  | `percentile`, `summarizeLatencies`                                                                                                                                               |
| `baseline.utils.ts` | baseline storage and comparison, Mann-Whitney U                                                                                                                                  |
| `metrics.utils.ts`  | `metric()` and `TaskMetrics` for task results                                                                                                                                    |
| `process.utils.ts`  | `spawnManagedProcess`, `waitForHealth`                                                                                                                                           |
| `report.utils.ts`   | ASCII tables and formatters                                                                                                                                                      |

## Measurement semantics

`bench` and the load windows keep their algorithms (warmup counts, nearest-rank percentiles,
post-warmup success-only latencies) so numbers stay comparable with saved baselines. Changing
anything that moves the numbers needs before/after output (`--compare-baseline`).

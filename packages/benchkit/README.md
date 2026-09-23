# benchkit

ReelVault's generic benchmarking machinery — measurement, statistics, A/B with
equivalence verification, load windows, server process management. Extracted
from `scripts/` so it can later be lifted into a standalone package.

**Bun-first.** Zero imports from `@/` — that is the package's hard boundary.
Everything that knows the database schema, ReelVault routes or seeding stays on
the application side (`scripts/benchmarks/*.bench.ts`, `scripts/benchmarks/lib/server.ts`).

## Usage in this repo

```bash
bun run benchmark                    # list suites
bun run benchmark matching           # one suite
bun run benchmark all                # everything in sequence (gc between suites)
bun run benchmark micro --only diacritics   # only units matching the regex (case-insensitive)
bun run benchmark database --strict  # exit 1 when an audit/comparison reports a failure
bun run benchmark --json matching    # JSON artifact (default benchmark-results/benchkit-latest.json)
bun run benchmark --save-baseline matching database   # save raw samples (benchmark-results/baseline.json)
bun run benchmark --compare-baseline matching database --strict
                                     # per-bench verdict: faster / slower / unchanged / noisy
                                     # (Mann-Whitney on raw samples, 3% delta threshold);
                                     # with --strict a "slower" verdict ends the run with exit 1
bun run scripts/benchmarks/micro.bench.ts   # standalone (main under import.meta.main)
```

Task names follow the `"<suite>: <phase>"` convention — `--only` targets them
unambiguously, and the JSON is self-describing.

## API

```ts
import { bench, compare, task, fixture, group, main, suiteArgs } from "benchkit";

export const meta = { description: "..." }; // shown by --help

const args = suiteArgs(); // memoized parse — bootstrap and files share one result

const server = fixture("server", async ({ onCleanup }) => {
	const s = await startBenchmarkServer({ seedRows: 5_000 });
	onCleanup(() => s.stop());

	return s;
});

group("Matching (sync, per call)", () => {
	bench("rankCandidates", ({ iteration }) => rankCandidates(windows[iteration % windows.length], q, 2015));
});

// Equivalence verification: when equal fails, no winner is declared.
compare("stripDiacritics", {
	variants: { NFD: stripNfd, map: stripMap },
	equal: (a, b) => a === b,
	batch: 32,
});

// Everything that is not a micro-measurement: load flows, audits, phase sequences.
task("http scenarios", async () => {
	const s = await server();
	// runLoadWindow({ concurrency, warmupMs, durationMs, work }) — the shared
	// deadline + discard-warmup + latency loop for all HTTP suites.
});

await main(import.meta); // the single tail line: --help → usage, otherwise runFile
```

Units are executed by the runner (`runDiscovery` / `runFile`):

- `bench()` — per-iteration timing (`measure`/`benchmark`), one table per `group`,
- `compare()` — batch + median ns/op (`abCompare`) with an optional `equal`,
- `task()` — custom output; `return { ok: false }` = soft failure (counts under `--strict`),
- fixtures — lazy, shared within a file, cleanup in reverse order even on error.

## Modules

| File | Role |
|---|---|
| `args.ts` | shared CLI parser (`--duration`, `--rows`, `--json`, `--strict`, …) + `suiteArgs()` (one parse per process) |
| `stats.ts` | percentiles, `summarizeLatencies` |
| `report.ts` | ASCII tables, formatters |
| `harness.ts` | micro-timing (`measure`/`benchmark`/`benchmarkAsync`/`measureAsync`), result printers, `runHttpScenario` |
| `compare.ts` | `abCompare` (batch+median), `compareVariants` (equal), `printAbResult` |
| `load.ts` | `runLoadWindow` (one load loop for http/streaming/upload/auth/…), `parseSegments` |
| `recorder.ts` | `Recorder` (per-op latencies + errors, `serialize()` to JSON) |
| `rss.ts` | RSS reads from `/proc`, `startRssSampler` (unref'd timer) |
| `process.ts` | `spawnManagedProcess`, `waitForHealth`, log-drain |
| `registry.ts` | `group`/`bench`/`compare`/`task`/`fixture` + unit collection |
| `baseline.ts` | `--save-baseline`/`--compare-baseline`: raw-sample storage, Mann-Whitney verdicts |
| `runner.ts` | discovery of `*.bench.ts`, execution, `--json` (schema `benchkit/v0`), `--strict` |
| `main.ts` | `await main(import.meta)` — the single tail line of a benchmark file |

## Measurement semantics

`bench` = today's `measure` (per-iteration, percentiles), `compare` = today's
`abCompare` (batch + median ns/op). Defaults and algorithms are untouchable —
numbers must stay comparable with historical baselines. Changing anything that
affects the numbers requires before/after numbers (AGENTS).

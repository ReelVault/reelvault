---
paths:
  - "scripts/benchmarks/**"
  - "packages/benchkit/**"
---

# Benchmarks

A suite is one file: `scripts/benchmarks/<name>.bench.ts`. `bun run benchmark <suite...>` imports it and runs what it registered; there is no other entry point. `packages/benchkit/README.md` documents the API and the flags.

```ts
import { runScenarioMatrix, suiteArgs, task } from "benchkit";
import { suiteServerFixture } from "./lib/server.fixture";

export const meta = { description: "..." }; // the suite list shows it

const args = suiteArgs(); // the run's flags; never parse process.argv in a suite
const serverFixture = suiteServerFixture(args);

task("<name>: <phase>", async () => {
	const server = await serverFixture();
	// load loops: runScenarioMatrix, runRequestScenario or runLoadWindow — never a hand-rolled deadline or warmup
});
```

## Rules

- Kinds: `bench()` times a micro-operation; `compare()` is an A/B test (add `equal` when the variants must produce the same result — a variant that does not is not a candidate); `task()` runs load flows and audits with their own tables.
- Task names are `"<suite>: <phase>"`, so `--only <regex>` matches unambiguously.
- Lifecycle comes from `suiteServerFixture` / `createServerFixture` (`lib/server.fixture.ts`) for a spawned server, and `benchDb` (`lib/db.fixture.ts`) for an in-process database. Seed data comes from `lib/seed.utils.ts` only — `seedCatalog` for in-process databases, `seedServerCatalog`/`seedServerProfiles` for the spawned server. Don't copy seeding SQL into a suite; extend the seeder. Timestamps are Unix seconds, as the schema stores them.
- `packages/benchkit` doesn't import `@/`. App-specific pieces live in `scripts/benchmarks/lib/`.
- The hot path is the code a suite exercises. Before changing it, run `bun run benchmark <suite> --only <regex> --save-baseline`; after the change, `--compare-baseline --strict`. The comparison is Mann-Whitney on raw samples with a 3% practical threshold, and "slower" fails the run.
- Metrics (`data.metrics`, such as RSS and CPU rows) use the 3% threshold without a significance test. Confirm them with repeated runs.
- To find where the time goes, run the suite with `--profile` and read the `.md` CPU profile of the process that did the work.
- `query-count` and `query-plan` are deterministic and run in CI with `--strict`: a new N+1 or a full scan fails the build.
- A change that moves numbers needs before/after output in the CHANGELOG entry or the PR.

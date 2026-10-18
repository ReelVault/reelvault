---
paths:
  - "scripts/benchmarks/**"
  - "packages/benchkit/**"
---

# Benchmarks

A suite is one file: `scripts/benchmarks/<name>.bench.ts`.

```ts
import { main, runHttpScenario, suiteArgs, task } from "benchkit";
import { createServerFixture } from "./lib/server-fixture";

export const meta = { description: "..." };
const args = suiteArgs(); // one memoized parse per process; never raw-parse here

if (!args.help) {
	const serverFixture = createServerFixture({ seedRows: args.rows, workerCount: Math.max(...args.concurrency) });

	task("<name>: <phase>", async () => {
		const server = await serverFixture();
		// load loops: use runLoadWindow or runHttpScenario; never hand-roll the deadline or warm-up
	});
}

await main(import.meta);
```

## Rules

- Kinds: `bench()` times a micro-operation; `compare()` is an A/B test (add `equal` when the variants must produce the same result); `task()` runs load flows and audits with their own tables.
- Task names are `"<suite>: <phase>"`, so `--only <regex>` matches unambiguously.
- Lifecycle comes from `createServerFixture` (`lib/server-fixture`) and `benchDb` plus `seedCatalog` (`lib/db-fixture`, `lib/seed`). Don't copy seeding SQL into a suite; extend the shared seeder.
- `packages/benchkit` doesn't import `@/`. App-specific pieces live in `scripts/benchmarks/lib/`.
- The hot path is the code a suite exercises. Before changing it, run `bun run benchmark <suite> --only <regex> --save-baseline`. After the change, run `--compare-baseline --strict`. The comparison is Mann-Whitney on raw samples with a 3% practical threshold, and "slower" fails the run.
- Metrics (`data.metrics`, such as RSS and CPU rows) use the 3% threshold without a significance test. Confirm them with repeated runs.
- A change that moves numbers needs before/after output in the CHANGELOG entry or the PR.

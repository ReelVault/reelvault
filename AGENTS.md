# ReelVault Media Server

Backend: Bun + ElysiaJS + Drizzle (SQLite) + Better Auth. Validation: `@sinclair/typebox`.
Prefer Bun native APIs (`Bun.file`, `Bun.serve`) over Node stdlib.

## Skills
- ALWAYS load and follow the `karpathy-guidelines` skill before starting any task.

## Definition of done (MANDATORY, every task)
Before declaring work finished, run ALL of these from the repo ROOT and get them green:

```bash
bun run format
bun run lint
bun run check-types
bun run deadcode
bun run test
```

- Run them after your LAST code change, not just once midway. Any edit invalidates earlier results.
- Fix failures at the root cause. Never report "done" with a red check. If a failure is pre-existing and unrelated, say so explicitly and show the evidence.
- Report what you ran and the outcome. Do not claim a check passed unless you actually ran it.
- `bun run format` does NOT sort imports. If lint complains about import order: `bunx biome check --write <files>`.
- Run `bun test` from the repo ROOT only (`bunfig.toml` preload doesn't apply in subdirectories).

## Forbidden: silencing tools
Never suppress a problem instead of fixing it. No linter blocks these, so YOU must:
- Suppression comments: `// biome-ignore`, `// oxlint-disable`, `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- Config weakening: turning a rule off or downgrading its severity in `biome.json`, `.oxlintrc.json`, `eslint.config.js` or `tsconfig.json`, or adding a file to their `ignores`/`ignorePatterns`.
- Dead-code hiding: knip `ignore*` entries or `@public` tags to make unused code disappear. Delete the code.
- Test evasion: `test.skip`, `test.todo`, loosened assertions, or deleting a failing test to get green.

If a rule seems genuinely wrong, STOP and ask. Do not work around it.

When a type error appears, fix the model, not the cast (`t.Nullable`/`t.Optional`, correct return types, hydrate data).

## Code style
- Flat, imperative, readable. No over-engineering, no deep nesting, no premature abstraction.
- DTOs via `Static<typeof Schema>`; DB rows via `$inferSelect`/`InferTable`. Use library types instead of hand-rolling.
- `exactOptionalPropertyTypes` is on: optional props receiving explicit `undefined` must be `foo?: T | undefined`.
- Formatting is owned by Biome (+ ESLint `padding-line-between-statements`). Never hand-format.

## Architecture (enforced by Biome)
- Clean Architecture: Domain / Application / Infrastructure. No DB schema or framework leakage into domain.
- `src/application/**` must NOT import `drizzle-orm`, `@/database/schema(s)`, `@/database/database`, `better-auth`, `elysia`. Put queries in repositories, return DTOs. Use `betterAuthApi.*`, never `auth.api.*`.
- Never `new X()` at module scope in a module that can be in an import cycle (TDZ). Use a lazy getter or callback registration.
- Errors: throw `DomainError` (`category` + `code` + `params`). API responses carry codes, never user-facing text.

## Critical invariants (breaking these caused real incidents)
- Error middleware order in `src/index.ts`: `domainErrorsMiddleware` BEFORE `httpExceptionPlugin()`.
- Never rely on `fs.watch` alone; keep the polling fallback in `waitForFile`.
- Serve media as lazy `BunFile`; thread `request.signal` through call chains; `throwIfAborted` before acquiring semaphores.
- In-memory and on-disk caches are always bounded (TTL/LRU + named constants); write paths must invalidate them. Timers: `.unref()` + clear on shutdown.
- Never hardcode CPU/RAM-dependent budgets or read `os.cpus()`. Derive from `system-resources.service`.
- SQLite is synchronous: keep queries minimal and indexed. Paginate via `findPageWithQueryMap`. Bulk-chunk id/value lists via `mapChunked`/`forEachChunked` (table-access).
- Repository methods that read identical across repos are often NOT identical: most classes override `findById`/`findByPrimaryId` with relation hydration, so delegating a "twin" `findByIdForRead` to the table-access object silently drops relations (the type checker rejects it). Never deduplicate textually-identical repo methods without checking for overrides first (attempted + reverted 2026-09-21).
- Schema changes go through migrations (`bun run db:generate`). Never `db:push`.
- After any `sdk/` change: `bun run build-sdk` and refresh the Website's copied `sdk/dist`.
- Any perf change: record before/after numbers, including regressions.

## Benchmarks (packages/benchkit)

A suite is one file: `scripts/benchmarks/<name>.bench.ts`. Skeleton:

```ts
import { main, runHttpScenario, suiteArgs, task } from "benchkit";
import { createServerFixture } from "./lib/server-fixture";

export const meta = { description: "..." };
const args = suiteArgs(); // one memoized parse per process — never raw-parse here

if (!args.help) {
	const serverFixture = createServerFixture({ seedRows: args.rows, workerCount: Math.max(...args.concurrency) });

	task("<name>: <phase>", async () => {
		const server = await serverFixture();
		// load loops: ALWAYS runLoadWindow / runHttpScenario — never hand-roll deadline/warmup
	});
}

await main(import.meta);
```

Rules:
- Unit kinds: `bench()` = micro-timing (measure), `compare()` = A/B with optional `equal` (add it whenever variants must be equivalent), `task()` = load flows/audits (own tables). Task names follow `"<suite>: <phase>"` so `--only <regex>` targets are unambiguous.
- Server/DB lifecycle: `createServerFixture` (lib/server-fixture) and `benchDb` + `seedCatalog` (lib/db-fixture, lib/seed). Never copy seeding SQL into a suite; extend the shared seeder's flags instead.
- `packages/benchkit` must not import `@/` — app-owned pieces stay in `scripts/benchmarks/lib/`.
- Selection/CI: `bun run benchmark <suite> --only <regex>`, `--json[=path]`, `--strict`. Before touching hot code: `--save-baseline`, after: `--compare-baseline --strict` (Mann-Whitney on raw samples, 3% practical threshold; "slower" fails the run). Changing anything that moves numbers requires before/after output comparison.

## Other commands
`db:generate`, `db:migrate`, `db:migrate:runtime`, `scenarios`.
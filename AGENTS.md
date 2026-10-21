# ReelVault Media Server

Backend: Bun, ElysiaJS, Drizzle (SQLite), Better Auth, TypeBox (`@sinclair/typebox`).
Prefer Bun APIs (`Bun.file`, `Bun.serve`) over Node stdlib.

Load the `karpathy-guidelines` skill before starting any task.

## Commands

Run from the repo root:

- `bun run format`: Biome formatting and import ordering. Biome's assist sorts imports (`assist.source.organizeImports` is on and `biome check` enforces it), so `bunx biome check --write <files>` orders the imports of the given files.
- `bun run lint`: Biome plus oxlint (type-aware) plus the duplication check.
- `bun run lint:duplicates`: jscpd copy/paste detector over `src/`. The budget is 1% duplicated lines.
- `bun run check-types`: TypeScript (`tsc --noEmit`, the TypeScript 7 native checker — ~0.3 s for the whole repo).
- `bun run check-types:bun`: the same project through Bun's own checker (`bun check`). It reports the same errors but is ~3x slower here, so it is a second opinion, not the gate.
- `bun run coverage`: runs the suite with coverage and fails under the line-coverage floor (75% of `src/`; today ~82%). `bun run coverage:report` prints the full report.
- `bun run deadcode`: knip.
- `bun run test`: full suite. `bun test` runs from the root only; `bunfig.toml` preloads don't apply in subdirectories.
- `bun run db:generate --name "descriptive_name"`, `db:migrate`, `db:migrate:runtime`, `scenarios`, `benchmark`.

The suite runs the real `ffmpeg` and `ffprobe`, so both must be on PATH.

## Definition of done

Before you report a task done, run `format`, `lint`, `check-types`, `deadcode` and `test` from the root after your last edit, and report each outcome. Fix a failure at its root cause. If a failure predates your change, say so and show the evidence.

## Changelog

- A behavior change updates `CHANGELOG.md` in the same task, under the newest heading without a git tag (currently `# v1.3.2`).
- Sections: `### Features` (user-facing functionality and API changes), `### Fixes` (concrete bugs and their cause), `### Performance`, `### Performance benchmarks`, `### Additional measurements`.
- Refactors and test cleanups are not logged. Entries are in English, with no commit hashes.
- A performance claim needs before/after numbers from `bun run benchmark`, regressions included. A bug fix does not.

## Rules enforced by tools

Don't work around these. If one seems wrong, stop and ask the user.

- No suppression comments (`biome-ignore`, `oxlint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`). When a type error appears, fix the model (TypeBox `t.Optional` or `t.Nullable`, return types, hydration), not the cast.
- No weakening of `biome.json`, `.oxlintrc.json` or `tsconfig.json`, and no new `ignores` or `ignorePatterns` entries.
- No knip `ignore` entries and no `@public` tags. Delete unused code.
- No `test.skip`, `test.todo`, `.only` or environment-gated `skipIf`. A test that cannot run fails loudly.
- A `DomainError` raised in a `catch` clause keeps the original error as `cause` (`scripts/lint/no-lost-error-cause.grit`).
- Cross-folder imports use `@/`; only same-folder imports stay relative (`import/no-relative-parent-imports`, off for tests and `src/config/version.constants.ts`).
- One import statement per module, and one array syntax (`T[]` for simple types, `Array<T>` for complex ones — `typescript/array-type` owns this).
- No explicit `any` — enforced by oxlint's `typescript/no-explicit-any`, not by Biome (Biome's `suspicious/noExplicitAny` is off so the two tools do not report the same diagnostic twice). The same split applies to the type-aware rules Biome cannot check: `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unsafe-type-assertion`.

`bun run lint:guard` checks the rules no linter ships: no suppression comments, no environment-gated test skips, no new ignore entries, no `@public` tags, the strict TypeScript flags, the registered grit plugins, and the severity of the rules the quality contract depends on.

## Readability rules

`biome.json` and `.oxlintrc.json` carry the house style; `scripts/lint/*.grit` holds the rules no linter ships.

- A ternary only picks between two short values. A branch that carries a call and runs past 80 characters, or any `await` inside a branch, is an `if`/`else` (or an early return) — `scripts/lint/long-ternary.grit` fails the build on it.
- One value, one dispatch: an `if`/`else if` chain that compares the same subject three or more times is a `switch` — `scripts/lint/else-if-chain.grit` fails the build on it.
- A module is the namespace: stateless helpers are named exports (`export function`). Never group them in an `export const *Utils = { ... }` object — `scripts/lint/no-namespace-object.grit` fails the build. Inside a utility module, functions call each other by name, never through the object.
- A class owns state, lifecycle or invariants. A stateless service is a `createX(deps)` factory returning functions or a plain object; it is never a class with only methods and no state.
- Conditions read positive: no `!` in a conditional that has an `else` branch, and no `else` after a `return` (`eslint/no-negated-condition`, `eslint/no-else-return`). The early-return form — `if (!ok) return;` — is the preferred shape; the rule only fires where an `else` would follow.
- One function, one job: cognitive complexity ≤ 20, ≤ 100 lines, ≤ 5 parameters, nesting ≤ 4 levels. Split a function instead of reaching for a deeper branch.
- One name per thing: `catch (error)`, no `forEach`/`reduce` where a loop says it better, no `console.log` outside scripts.
- Nullish checks go through `isNullish()` / `isNotNullish()` (`src/utils/type.utils.ts`); `==`/`!=` are banned (`eslint/eqeqeq`).
- Copy-paste is a bug waiting to happen: the duplication budget is 1% (`bun run lint:duplicates`). Extract the shared part instead of cloning it.

## Code

- Flat, imperative code. No speculative abstractions, no deep nesting.
- DTOs come from `Static<typeof Schema>`; DB rows from `$inferSelect` or `InferTable`. Use library types instead of hand-rolling them.
- `exactOptionalPropertyTypes` is on: an optional property that can receive an explicit `undefined` is typed `foo?: T | undefined`.
- Biome owns formatting. Don't hand-format.

## Architecture

- Layers: `app/` (features, repositories, HTTP, wiring) sits above `modules/`, `plugins/`, `workers/`, `system/`, `integrations/`, `config/` and `utils/`. Queries live in `app/repositories/` and return DTOs. Use `betterAuthApi.*`, not `auth.api.*`. The import rules are under Layout and naming.
- Errors: throw `DomainError(category, message, { code, params })`. The message is for logs. API responses carry the code and params, never user-facing text.
- No `new X()` at module scope in a module that can sit in an import cycle (TDZ). Use a lazy getter or a callback registration.
- `detach()` takes only promises that cannot reject. A fire-and-forget task catches and logs its own errors before it is detached.
- Repository methods that look identical often aren't: most repositories override `findById` or `findByPrimaryId` to hydrate relations. Check for overrides before deduplicating.

## Layout and naming

This is the agreed layout. Put new code where it belongs. Don't create a new top-level folder in `src/`, and don't add a loose file to the `src/` root (only `src/index.ts`), without asking the user first.

```
src/
├── index.ts          entry point (boot)
├── app/              features: use cases, repositories, types, one folder per feature
│   ├── http/         Elysia server: routes (*.routes.ts), middleware, schemas, web UI serving, HTTP helpers
│   ├── repositories/ one repository per entity; readers (*.reader.ts) for large cross-entity reads; queries return DTOs
│   ├── plugins/      app services that plugins call
│   ├── wiring/       startup wiring: registers the ports each layer reads
│   └── <feature>/    admin, auth, catalog, libraries, media, playback, ...
├── modules/          DB-free engines: streaming, scanner, images, subtitles, trickplay, downloads, realtime, metadata-sidecars, ...
├── plugins/          top layer: loader, lifecycle, catalog, capability implementations
├── workers/          background job runtime and job handlers; dependencies injected at startup
├── system/           runtime supervisors: resource allocator, server rescue, shutdown, data directories, extensions/ (contracts only)
├── integrations/     external processes and services: ffmpeg, ffprobe, sharp, better-auth, drizzle-orm (schemas, relations, migrations, factory, query building)
├── config/           env, server settings (config/server/), system settings, version, host resource service (system-resources.service), worker id categories, rate-limit overrides
└── utils/            pure helpers; no application dependencies
```

- Server settings live under `config/server/`, not in a separate top-level folder.
- Each folder has one responsibility. Place a file by the feature that uses it, not by its kind ("service", "helper").
- Import direction: `app/` sits on top. It calls `modules/`, `plugins/`, `workers/`, `system/`, `integrations/`, `config/` and `utils/`, which sit below it. Biome enforces these layers (`style/noRestrictedImports` in `biome.json`, alias imports only):
  - `modules/` doesn't import `app/`, `plugins/`, `workers/`, `drizzle-orm`, the database factory or schema, `better-auth` or `elysia`. Its data arrives through ports that `app/wiring/module-ports.ts` registers at startup.
  - `plugins/` doesn't import `app/repositories/`, `drizzle-orm`, the database factory or schema, `better-auth` or `elysia`. They call app services such as `app/plugins/plugin-data.service.ts`.
  - `workers/` doesn't import `app/` or `plugins/`. Stores and services are injected at startup through `app/wiring/worker-ports.ts`.
  - `system/` doesn't import `app/`, `plugins/`, `workers/` or `modules/`. It reaches them through `system/system.ports.ts`, which `app/wiring/system-ports.ts` wires.
  - `integrations/` doesn't import `app/`, `modules/`, `plugins/`, `workers/` or `system/`. Its app-side collaborators arrive through ports: `integrations/better-auth/better-auth.ports.ts` and `integrations/drizzle-orm/utils/provider-entity-sync.ports.ts`, both wired in `app/wiring/integration-ports.ts`.
  - `config/` and `utils/` depend on each other only, and never on features, plugins, workers, `system/`, `modules/` or `integrations/`.
  - `elysia` is imported only in `app/http/` and in `*.routes.ts` files.
  - Relative imports are not checked. Use `@/` for imports across folders.
- Inside `integrations/drizzle-orm/`, the database layers are separate:
  - `query/` holds generic building blocks that know no feature: table access, query parsers (`parsing/`), keyset pagination (`keyset/`), transactions, prepared statements.
  - `utils/` holds helpers tied to a domain (joins, stable keys, provider sync, media projections).
  - `schemas/`, `relations.schema.ts`, `migrations/` and `database.factory.ts` hold the schema, the relation graph, the migrations and the connection factory.
- Repositories live in `app/repositories/`: one per entity, with its simple relation reads (`metadata-relations/`). Large cross-entity reads, such as recommendations, live in `*.reader.ts` files there. They return DTOs.
- `config/system-resources.service.ts` stays in `config/`, although it reads host CPU and RAM at runtime. About 70 files import it, including `integrations/` and `utils/`, and those layers can't import `system/`. Don't move it to `system/` unless the layer rules change first.
- Inside `app/catalog/metadata/`, group files by responsibility (`refresh/`, `process/`, `records/`, `providers/`). `metadata.service.ts` stays the facade. Don't group by file type (`service/`, `metadata-process/`).

### File names

- A file is `<subject>.<role>.ts`, where the role suffix says what the file does. Reuse the existing suffixes: `service`, `repository`, `schema`, `routes`, `reader`, `writer`, `mapper`, `validator`, `guard`, `middleware`, `cache`, `factory`, `runtime`, `adapter`, `store`, `runner`, `scheduler`, `policy`, `manager`, `loader`, `parser`, `builder`, `registry`, `utils`, `types`, `constants`, `config`, `definitions`, `bench`, `resolver`, `strategy`, `publisher`, `importer`, `tracker`, `pipeline`, `cleaner`, `extractor`, `watcher`, `operation`, `limiter`, `aggregator`, `errors`, `failures`, `environment`, `plugin`, `scanner`, `processor`, `matcher`, `logger`, `recorder`, `monitor`, `initializer`, `reaper`, `seeker`, `coordinator`, `lookup`, `waiter`, `selector`, `locator`, `walker`, `exporter`, `eviction`, `diagnostics`, `indexer`, `fetcher`, `hardener`, `fanout`, `projection`, `allocator`, `connection`, `installer`, `history`, `report`. Test-only helpers use `.helper.ts` or `.fixture.ts`, scripts use `.script.ts`, and the preload is `tests/test.preload.ts`.
- Don't invent a new suffix without asking. Don't use `.common`, `.helpers`, `.misc`, `.validation` (use `.validator`), `.schemas` (use `.schema`) or `.definition` (use `.definitions`).
- The only files without a role suffix are `index.ts` entry points and barrels.
- A test file is `<subject>.test.ts`, named after the module it covers.

### Lifecycle

Know when a piece of code runs before you put it somewhere.

| Folder | When it runs | Rule |
|---|---|---|
| `config/` | read at boot; system settings read through a cache; the resource monitor runs from boot to shutdown | a write invalidates the cache; the monitor timer is `.unref()` and cleared at shutdown |
| `integrations/drizzle-orm/` | opened and migrated at boot | closed late in shutdown, after everything that writes to it |
| `system/` | the resource allocator and server rescue timers start at boot | `.unref()` and cleared at shutdown |
| `plugins/` | loaded at boot; installed or updated while running | unloaded before the database closes |
| `workers/` | scheduler and pools start after the database | stopped before the database closes |
| `modules/` | started by `app/` and `workers/` | ffmpeg processes killed at shutdown |
| `app/` | per request only (HTTP and use cases) | no global mutable state |

Shutdown order (`system/shutdown.service.ts`): realtime, http, library-watchers, resource-allocator, server-rescue, workers, download-sweeps, streaming, ffmpeg, plugins, database. Intake stops first, and the database closes last.

Before you add or move a file, check this section. If no folder fits, ask the user instead of creating one. Moves and renames are refactors and get no CHANGELOG entry.

## Schema and migrations

- The schema, relations and migrations live in `src/integrations/drizzle-orm/` (`migrations/`).
- Schema changes go through `bun run db:generate --name "..."`. Never `db:push`. Never hand-write, edit or assemble migration files.
- Between releases, squash the unreleased migrations: delete their folders and run `db:generate` once. Never edit a released migration.
- After a change in `sdk/`, publish from `sdk/`, then bump `@reelvault/sdk` here and in the website and plugin consumers.

## Runtime invariants

- In `src/index.ts`, `domainErrorsMiddleware` is registered before `httpExceptionPlugin()`.
- Keep the polling fallback in `waitForFile`. `fs.watch` alone misses events on some filesystems.
- Serve media as lazy `BunFile`. Thread `request.signal` through call chains. Call `throwIfAborted` before acquiring a semaphore.
- Caches are bounded (TTL or LRU, with named constants), and writes invalidate them. Timers are `.unref()` and cleared on shutdown.
- Never hardcode CPU or RAM budgets and never read `os.cpus()`. Derive budgets from `system-resources.service`.
- SQLite is synchronous. Keep queries indexed and minimal, paginate with `findPageWithQueryMap`, and chunk id lists with `mapChunked` or `forEachChunked`.

## Detailed rules

These load when you work on matching files:

- `.claude/rules/testing.md`: tests (`**/*.test.ts`, `tests/**`).
- `.claude/rules/benchmarks.md`: benchmark suites (`scripts/benchmarks/**`, `packages/benchkit/**`).

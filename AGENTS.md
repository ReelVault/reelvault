# ReelVault Media Server

Backend: Bun, ElysiaJS, Drizzle (SQLite), Better Auth, TypeBox (`@sinclair/typebox`).
Prefer Bun APIs (`Bun.file`, `Bun.serve`) over Node stdlib.

Load the `karpathy-guidelines` skill before starting any task.

## Commands

Run from the repo root:

- `bun run format`: Biome formatting and import ordering. Biome's assist sorts imports (`assist.source.organizeImports` is on and `biome check` enforces it), so `bunx biome check --write <files>` orders the imports of the given files.
- `bun run lint`: Biome plus oxlint (type-aware) plus the duplication check plus the test-quality check.
- `bun run lint:duplicates`: jscpd copy/paste detector over `src/`. The budget is 1% duplicated lines.
- `bun run lint:tests`: fails on a test file that cannot catch a bug — a recomputed expectation, an existence-only case, a call-only case, a bare `toThrow()`, a loose bound, or a file that exercises another folder's code. See **Tests**.
- `bun run mutation`: rewrites the implementation and counts the mutants the suite kills. It measures sensitivity, not correctness. Use it to find dead weight, never as a certificate.
- `bun run check-types`: TypeScript (`tsc --noEmit`, the TypeScript 7 native checker — ~0.3 s for the whole repo).
- `bun run check-types:bun`: the same project through Bun's own checker (`bun check`). It reports the same errors but is ~3x slower here, so it is a second opinion, not the gate.
- `bun run coverage`: runs the suite with coverage and fails under the line-coverage floor (75% of `src/`; today ~82%). `bun run coverage:report` prints the full report.
- `bun run deadcode`: knip.
- `bun run test`: full suite. `bun test` runs from the root only; `bunfig.toml` preloads don't apply in subdirectories.
- `bun run db:generate --name "descriptive_name"`, `db:migrate`, `db:migrate:runtime`, `scenarios`, `benchmark`.

The suite runs the real `ffmpeg` and `ffprobe`, so both must be on PATH.

## Definition of done

Before you report a task done, run `format`, `lint`, `check-types`, `deadcode` and `test` from the root after your last edit, and report each outcome. Fix a failure at its root cause. If a failure predates your change, say so and show the evidence.

## Tests

A test earns its place by failing when a behavior that matters breaks. A test that cannot fail is worse than no test: it costs reading time, it reports a green tick that carries no information, and it teaches everyone to trust a signal that means nothing.

`.claude/rules/testing.md` holds the long form with the worked examples. This section is the contract every test must satisfy.

### The five gates

Every test case passes all five. A case that fails one is rewritten or deleted, never merged.

1. **Provenance** — the expected value is a fact, not a recomputation of the subject.
2. **Sensitivity** — breaking the implementation makes the test fail.
3. **Outcome** — the test asserts what the system produced, not how it was called.
4. **Ownership** — the file that asserts the behavior owns the code.
5. **Independence** — the test passes on every machine and on every build.

#### 1. Provenance — the expected value is a fact

The expected side of an assertion is a **fact about the behavior**: a literal, a stored row read back, bytes read from the real system, a value an external specification fixes (RFC 9110, RFC 4122, a real ffmpeg banner, an HTTP status).

It is never a **recomputation of the subject**. Two forms of the same trap:

- **The same function.** The expected side calls the function under test.
- **The same helper.** The expected side calls a helper the code under test also calls. The helper's correctness is then never verified — the test only proves it was called with the right arguments. A helper that produces the expected value needs its own test, with literals.

| Never | Instead |
|---|---|
| `expect(parseEntry(x)).toEqual(parseEntry(x))` | a literal for the expected shape |
| `expect(result.key).toBe(createStableKey(x))` | the literal key, so the format is pinned |
| `expect(fingerprint).toBe(profilePinFingerprint(pin))` | the literal fingerprint |
| `expect(dedupeKey).toBe(createDedupeKey(paths))` | the literal dedupe key |
| `expect(total).toBe(items.reduce(sum, 0))` | the literal total |
| `expect(second).toBe(encryptSecret(first))` | two literals, so the ciphertext is not pinned to the implementation |

The same rule applies to a constant: a constant used as the expected value is built from literals, not from a call into the subject.

A helper that reads the world — the filesystem, the network, the database — is a fact, not a recomputation. Reading a file back to prove it was not rewritten stays.

#### 2. Sensitivity — would it fail?

Before you finish a test, break the code path it covers: flip one condition or change one value, run the test, confirm it fails, restore the code. A test that still passes protects nothing.

`bun run mutation` measures this across the whole suite: it rewrites the implementation and counts the mutants the suite kills. It reports **sensitivity, not correctness** — a suite can be sensitive and still assert the wrong value. Use it to find dead weight, never as a certificate.

#### 3. Outcome — assert what happened, not how

Assert the returned value, the stored row, the response body, the emitted payload. Not which collaborator was called, and not with which arguments.

| Never | Instead |
|---|---|
| `expect(repo.findById).toHaveBeenCalledWith(id)` | the row the repository returns |
| `expect(mock.save).toHaveBeenCalledTimes(1)` | the stored row |
| `expect(result).toBe(stubReturn)` | the value the service produced from it |

A call assertion is allowed only when the call itself is the invariant, and the title says so.

#### 4. Ownership — the file owns the code

A test file under `src/` exercises a module from its own folder. A test that covers another area's code belongs to that area: it makes the coverage map lie, and it makes the test read as noise.

#### 5. Independence — the machine and the build

A test that passes on your box and fails on the CI runner is a broken test, not a flaky one. Three things leak the environment in.

**The host.** What the machine has — a GPU, a DRM render node, a core count — is not an input the test controls. The production code takes it as a parameter, so the test passes it in:

```ts
const args = buildTranscodeVideoArgs(decision, config, hw("nvenc"), toneMap("none"));
```

When the production code reads the host itself, the test replaces the module (`mockModuleWithRealExports`). A test may not call a probe of the detected capabilities — `getEffectiveHwaccel`, `getFfmpegCapabilities`, `resolveEffectiveHwaccel`, `getDetectedDriDevice` — except in the test that owns the module declaring them.

**The build.** The suite runs against whatever ffmpeg the machine has: upstream ffmpeg, jellyfin-ffmpeg, or a minimal build. They advertise different filters and encoders, so a test that asserts on the *detected* set asserts on the build. Test those decisions with literal sets instead — a fixture, never the probe's output.

**The clock.** A test that measures elapsed time may only compare it against a bound the test itself pins. A bound taken from the host's speed factor or a hard-coded millisecond count is a race against the runner.

### What a test may never contain

- **Existence**: `.toBeDefined()`, `.toBeTruthy()`, `typeof x === "function"`, a bare `not.toThrow()`. Assert the value the code produces.
- **A loose bound**: `toBeGreaterThan(0)`, `toBeGreaterThanOrEqual(1)`. Any value passes.
- **A call as the only assertion** — see gate 3.
- **A stub's own value** as the expectation.
- **An error message** as the expectation. Assert `category` and `code`.
- **A whole object** when only one field carries an invariant. Use `toMatchObject`.
- **A constant table** with no behavior behind it.
- **Third-party behavior**: TypeBox, Elysia, Drizzle, Better Auth, Bun, SQLite, the ffmpeg CLI's own output format.
- **A schema-enforced rule**: per-field rejections belong in the schema. One boundary test per route shows the schema is wired.
- **A duplicate**: the same behavior in two files. Keep it in the file that owns the code.
- **An assertion-free case**: code run for coverage with nothing checked.

### Shape

- **Title**: one sentence in domain language, stating the condition and the outcome: `refuses to restore while a stream is active`. Never "works", "handles" or "should".
- **Structure**: arrange, act, assert. One behavior per test. Set up only what the test needs.
- **Async**: always `await` `.rejects` and `.resolves`. An un-awaited assertion can pass without running.
- **Errors**: assert `category` and `code`, never the message text.
- **Mocks**: only what leaves the process — network, ffmpeg, ffprobe, the clock, external plugins. If the mock setup is longer than the assertion, use the real dependency or move the test up a layer.

### The gate

`bun run lint:tests` fails on a test file that cannot catch a bug: an expected value recomputed with the code under test, an expected value that is a constant the code under test defines, a case that only asserts existence, a case that only asserts a call, a bare `toThrow()`, a loose bound, a file that exercises another folder's code, or a test that reads the host's detected capabilities instead of mocking them. `bun run lint` runs it.

Fix the assertion, not the rule.

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

- Layers: `api/` (HTTP transport), `services/` (use cases), `repositories/` (data access) and `wiring/` (composition root) sit above `modules/`, `plugins/`, `workers/`, `system/`, `integrations/`, `config/` and `utils/`. Queries live in `repositories/` and return DTOs. Use `betterAuthApi.*`, not `auth.api.*`. The import rules are under Layout and naming.
- Errors: throw `DomainError(category, message, { code, params })`. The message is for logs. API responses carry the code and params, never user-facing text.
- No `new X()` at module scope in a module that can sit in an import cycle (TDZ). Use a lazy getter or a callback registration.
- `detach()` takes only promises that cannot reject. A fire-and-forget task catches and logs its own errors before it is detached.
- Repository methods that look identical often aren't: most repositories override `findById` or `findByPrimaryId` to hydrate relations. Check for overrides before deduplicating.

## Layout and naming

This is the agreed layout. Put new code where it belongs. Don't create a new top-level folder in `src/`, and don't add a loose file to the `src/` root (only `src/index.ts`), without asking the user first.

```
src/
├── index.ts          entry point (boot)
├── api/              HTTP transport: Elysia server — routes (*.routes.ts), middleware, schemas, web UI serving, HTTP helpers
├── services/         use cases: one folder per feature (admin, auth, catalog, libraries, media, playback, plugins, trickplay, ...)
├── repositories/     data access: one repository per entity; readers (*.reader.ts) for large cross-entity reads; queries return DTOs
├── wiring/           composition root: registers the ports each layer reads
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
- The four application layers have one direction each: `api/` calls `services/`, `services/` calls `repositories/`, and `wiring/` calls all of them. `repositories/` never calls upward. Biome enforces these layers (`style/noRestrictedImports` in `biome.json`, alias imports only):
  - `api/` doesn't import `repositories/`, `workers/` or `integrations/`. A read, a job enqueue and a framework call go through the service that owns them. It may import `services/`, and it may import `modules/` and `plugins/` for transport work (HLS segments, WebSocket frames, served files, the plugin host) — those calls are transport, not use cases.
  - `services/` doesn't import `api/`. Use cases take plain data; the HTTP layer calls them, not the other way round.
  - `repositories/` doesn't import `services/` or `api/`. It is the leaf of the application: it knows no use case and no request.
  - `modules/` doesn't import `api/`, `services/`, `repositories/`, `plugins/`, `workers/`, `drizzle-orm`, the database factory or schema, `better-auth` or `elysia`. Its data arrives through ports that `wiring/module-ports.ts` registers at startup.
  - `plugins/` doesn't import `repositories/`, `drizzle-orm`, the database factory or schema, `better-auth` or `elysia`. They call application services such as `services/plugins/plugin-data.service.ts`.
  - `workers/` doesn't import `api/`, `services/`, `repositories/` or `plugins/`. Stores and services are injected at startup through `wiring/worker-ports.ts`.
  - `system/` doesn't import `api/`, `services/`, `repositories/`, `plugins/`, `workers/` or `modules/`. It reaches them through `system/system.ports.ts`, which `wiring/system-ports.ts` wires.
  - `integrations/` doesn't import `api/`, `services/`, `repositories/`, `modules/`, `plugins/`, `workers/` or `system/`. Its app-side collaborators arrive through ports: `integrations/better-auth/better-auth.ports.ts` and `integrations/drizzle-orm/utils/provider-entity-sync.ports.ts`, both wired in `wiring/integration-ports.ts`.
  - `config/` and `utils/` depend on each other only, and never on the application layers, plugins, workers, `system/`, `modules/` or `integrations/`.
  - `elysia` is imported only in `api/` and in `*.routes.ts` files.
  - Relative imports are not checked. Use `@/` for imports across folders.
- Inside `integrations/drizzle-orm/`, the database layers are separate:
  - `query/` holds generic building blocks that know no feature: table access, query parsers (`parsing/`), keyset pagination (`keyset/`), transactions, prepared statements.
  - `utils/` holds helpers tied to a domain (joins, stable keys, provider sync, media projections).
  - `schemas/`, `relations.schema.ts`, `migrations/` and `database.factory.ts` hold the schema, the relation graph, the migrations and the connection factory.
- Repositories live in `repositories/`: one per entity, with its simple relation reads (`metadata-relations/`). Large cross-entity reads, such as recommendations, live in `*.reader.ts` files there. They return DTOs.
- A repository never sees an HTTP concept. The audit log, for example, stores flat columns; the caller context (`services/admin/audit-context.types.ts`) is flattened by the audit service before it reaches the repository.
- `config/system-resources.service.ts` stays in `config/`, although it reads host CPU and RAM at runtime. About 70 files import it, including `integrations/` and `utils/`, and those layers can't import `system/`. Don't move it to `system/` unless the layer rules change first.
- Inside `services/catalog/metadata/`, group files by responsibility (`refresh/`, `process/`, `records/`, `providers/`). `metadata.service.ts` stays the facade. Don't group by file type (`service/`, `metadata-process/`).

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
| `modules/` | started by `services/` and `workers/` | ffmpeg processes killed at shutdown |
| `wiring/` | at boot, before the server listens | registers the ports every layer reads; nothing else |
| `services/` | per request only (use cases) | no global mutable state |
| `repositories/` | per request only (data access) | no global mutable state beyond bounded caches |
| `api/` | per request only (HTTP transport) | no global mutable state |

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

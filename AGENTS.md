# ReelVault Media Server

Backend: Bun, ElysiaJS, Drizzle (SQLite), Better Auth, TypeBox (`@sinclair/typebox`).
Prefer Bun APIs (`Bun.file`, `Bun.serve`) over Node stdlib.

Load the `karpathy-guidelines` skill before starting any task.

## Commands

Run from the repo root:
- `bun run format`: Biome formatting and import ordering (`bunx biome check --write <files>` for some files).
- `bun run lint [check...]`: every static check, side by side, reporting all failures in one run (`scripts/lint/lint.script.ts`). The checks: `biome`, `oxlint` (type-aware), `types` (`tsc --noEmit`, the TypeScript 7 native checker), `deadcode` (knip, import cycles included), `duplicates` and `duplicates-strict` (jscpd; the budget is 1% duplicated lines), `tests` (the test-quality gate, see **Tests**), `guard` (rules no linter ships) and `migrations` (schema changes without a migration). Name checks to run only those: `bun run lint types tests`.
- `bun run test`: the full suite, parallel, each file isolated. `bun test` runs from the root only; `bunfig.toml` preloads don't apply in subdirectories.
- `bun run coverage`: the same run with coverage; fails on a failing test or under the line-coverage floor (75% of `src/`; today ~85%). CI runs this instead of `test`.
- `bun run mutation`: rewrites the implementation and counts the mutants the suite kills. It measures sensitivity, not correctness. Use it to find dead weight, never as a certificate. `bun run mutation -- --plan` prints the subject count and the run budget without running a test; `bun run mutation -- --files=<path> --max-mutants=4 --max-tests=2` checks one module. Run it alone: it rewrites production files while it runs.
- `bun run benchmark <suite...>`: the benchmark suites (`packages/benchkit/README.md`); without a suite it lists them.
- `bun run db:generate --name "descriptive_name"`, `db:migrate`, `db:studio`, `db:seed`, `db:check`, `db:vacuum`, `db:backup`.
- `bun run doctor`, `admin:reset-password`, `admin:two-factor-enforcement`: the administration commands in `scripts/admin/`. They ship in the release archive and run there as `./start.sh <command>` (`start.bat` on Windows).

The suite runs the real `ffmpeg` and `ffprobe`, so both must be on PATH. Git hooks (lefthook: Biome and oxlint on commit, `lint` and `test` on push) are installed with `bunx lefthook install`; `bunfig.toml` keeps `bun install` from running lifecycle scripts, so they are not installed automatically.

## Definition of done

Before you report a task done, run `format`, `lint` and `test` from the root after your last edit, and report each outcome. Fix a failure at its root cause. If a failure predates your change, say so and show the evidence.

## Tests

A test earns its place by failing when a behavior that matters breaks. A test that cannot fail is worse than no test: it costs reading time, it reports a green tick that carries no information, and it teaches everyone to trust a signal that means nothing.

`.claude/rules/testing.md` holds the long form with the worked examples. This section is the contract every test must satisfy.

When a test fails, the production code is the suspect first. A test is never bent to match the code (gate 6).

### The six gates

Every test case passes all six. A case that fails one is rewritten or deleted, never merged.
1. **Provenance** — the expected value is a fact, not a recomputation of the subject.
2. **Sensitivity** — breaking the implementation makes the test fail.
3. **Outcome** — the test asserts what the system produced, not how it was called.
4. **Ownership** — the file that asserts the behavior owns the code.
5. **Independence** — the test passes on every machine and on every build.
6. **Reality** — the case is one the product produces, and the expected value is what the behavior should give for it.

#### 1. Provenance — the expected value is a fact

The expected side of an assertion is a **fact about the behavior**: a literal, a stored row read back, bytes read from the real system, a value an external specification fixes (RFC 9110, RFC 4122, a real ffmpeg banner, an HTTP status).

It is never a **recomputation of the subject**. Three forms of the same trap:
- **The same function.** The expected side calls the function under test.
- **The same helper.** The expected side calls a helper the code under test also calls. The helper's correctness is then never verified — the test only proves it was called with the right arguments. A helper that produces the expected value needs its own test, with literals.
- **The same subject, twice.** The expected side is another output of the function under test: `expect(f(a)).toBe(f(b))` proves the two agree, not that either is right. Pin both sides to literals. The gate flags a call written in the expected expression; it does not see a variable that holds an earlier output.

| Never                                                  | Instead                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `expect(parseEntry(x)).toEqual(parseEntry(x))`         | a literal for the expected shape                                    |
| `expect(result.key).toBe(createStableKey(x))`          | the literal key, so the format is pinned                            |
| `expect(fingerprint).toBe(profilePinFingerprint(pin))` | the literal fingerprint                                             |
| `expect(dedupeKey).toBe(createDedupeKey(paths))`       | the literal dedupe key                                              |
| `expect(total).toBe(items.reduce(sum, 0))`             | the literal total                                                   |
| `expect(second).toBe(encryptSecret(first))`            | two literals, so the ciphertext is not pinned to the implementation |
| `expect(kebab.allocated).toBe(camel.allocated)`        | the literal allocation both worker ids must produce                 |

The same rule applies to a constant: a constant used as the expected value is built from literals, not from a call into the subject.

A helper that reads the world — the filesystem, the network, the database — is a fact, not a recomputation. Reading a file back to prove it was not rewritten stays.

#### 2. Sensitivity — would it fail?

Before you finish a test, break the code path it covers: flip one condition or change one value, run the test, confirm it fails, restore the code. A test that still passes protects nothing.

`bun run mutation` measures this across the whole suite: it rewrites the implementation and counts the mutants the suite kills. It reports **sensitivity, not correctness** — a suite can be sensitive and still assert the wrong value. Use it to find dead weight, never as a certificate.

#### 3. Outcome — assert what happened, not how

Assert the returned value, the stored row, the response body, the emitted payload. Not which collaborator was called, and not with which arguments.

| Never                                            | Instead                                |
| ------------------------------------------------ | -------------------------------------- |
| `expect(repo.findById).toHaveBeenCalledWith(id)` | the row the repository returns         |
| `expect(mock.save).toHaveBeenCalledTimes(1)`     | the stored row                         |
| `expect(result).toBe(stubReturn)`                | the value the service produced from it |

A call assertion is allowed only when the call itself is the invariant, and the title says so.

#### 4. Ownership — the file owns the code

A test file under `src/` exercises a module from its own folder. A test that covers another area's code belongs to that area: it makes the coverage map lie, and it makes the test read as noise.

#### 5. Independence — the machine and the build

A test that passes on your box and fails on the CI runner is a broken test, not a flaky one. Five things leak the environment in.

**The host.** What the machine has — a GPU, a DRM render node, a core count — is not an input the test controls. The production code takes it as a parameter, so the test passes it in:

```ts
const args = buildTranscodeVideoArgs(decision, config, hw("nvenc"), toneMap("none"));
```

When the production code reads the host itself, the test replaces the module (`mockModuleWithRealExports`). A test may not call a probe of the detected capabilities — `getEffectiveHwaccel`, `getFfmpegCapabilities`, `resolveEffectiveHwaccel`, `getDetectedDriDevice` — except in the test that owns the module declaring them.

**The subject reads the host too.** A test that exercises a _detection_ inherits every host read inside the subject, even the ones it never touches: a DRM-backed accelerator needs a `/dev/dri` node, the software encoder's preset and x264 lookahead scale with the measured CPU speed. Pin those inputs — mock the probe the subject calls, or stub the speed factor. The worker concurrency that the allocator derives from the host CPU count is stubbed to a literal before any allocated value is asserted.

**The build.** The suite runs against whatever ffmpeg the machine has: upstream ffmpeg, jellyfin-ffmpeg, or a minimal build. They advertise different filters and encoders, so a test that asserts on the _detected_ set asserts on the build. Test those decisions with literal sets instead — a fixture, never the probe's output.

**The clock.** A test that measures elapsed time may only compare it against a bound the test itself pins. A bound taken from the host's speed factor or a hard-coded millisecond count is a race against the runner.

**The run.** Every test file in one `bun test` run shares one process, so process-wide state carries over from file to file: the rate limiter's buckets, the settings store, the caches. A file that exhausts a budget clears it in `afterAll`. A file that depends on a budget clears it in `beforeEach`, so no earlier file can change its result. A file that passes alone is no evidence for the run; the full suite is the check.

#### 6. Reality — the case is one the product produces

The input is a case the product really handles: a real file, a real row, a real request, a value a user or an external provider sends. The expected value is what the behavior should produce for that input, settled from the behavior before the code is consulted.

A fixture shaped to what the implementation does today passes by accident, and it hides the bug the test exists to catch. Replace it with a real case.

When a test fails, the production code is the suspect first:
- Fix the function when it is wrong, and keep the assertion.
- Change an expected value only when the old one contradicts a written fact: a specification, a documented behavior, a reported bug. Name the fact in the commit or the CHANGELOG.
- Never move an expected value to what the new code prints because the code now does something else. That ships a defect with a green test attached.

`bun run lint tests` checks the static forms listed under _The gate_. Reality, outcome and sensitivity need a reviewer and the mutation check under gate 2.

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
- **A shaped fixture**: input built to fit what the implementation does today, not a case the product produces (gate 6).

### Shape

- **Title**: one sentence in domain language, stating the condition and the outcome: `refuses to restore while a stream is active`. Never "works", "handles" or "should". A title that names a mechanism (a cache, a database lookup, a symlink dereference, a retry) needs an assertion that observes that mechanism; otherwise the title names only the outcome.
- **Structure**: arrange, act, assert. One behavior per test. Set up only what the test needs.
- **Async**: always `await` `.rejects` and `.resolves`. An un-awaited assertion can pass without running.
- **Errors**: assert `category` and `code`, never the message text.
- **Mocks**: only what leaves the process — network, ffmpeg, ffprobe, the clock, external plugins. If the mock setup is longer than the assertion, use the real dependency or move the test up a layer. `stubMethod` refuses a name the target has no method for, so a stale stub fails instead of steering nothing.
- **Time zone**: a date bug that only shows away from UTC is pinned with `useTimeZone()` (`tests/helpers/time-zone.helper.ts`), never with the runner's zone.
- **Plugin hooks**: register a real hook on `pluginHookBus` and unsubscribe it in `afterEach`; don't stub the bus.

### The gate

`bun run lint tests` fails on a test file that cannot catch a bug: an expected value recomputed with the code under test, an expected value that is a constant the code under test defines, a case that only asserts existence, a case that only asserts a call, a bare `toThrow()`, a loose bound, a file that exercises another folder's code, or a test that reads the host's detected capabilities instead of mocking them. `bun run lint` runs it.

Fix the assertion, not the rule.

The gate matches the static forms above. Reality, outcome and sensitivity need a reviewer and the mutation check under gate 2: name the mutation and the test it fails before you call a test done.

## Changelog

- A behavior change updates `CHANGELOG.md` in the same task, under the newest heading without a git tag (currently `# v1.3.2`).
- Sections: `### Features` (user-facing functionality and API changes), `### Fixes` (concrete bugs and their cause), `### Performance`, `### Performance benchmarks`, `### Additional measurements`.
- Write for a reader who does not know the codebase: one or two short sentences per entry, in the right section. Say what changed and, for performance, **Before → After**. Never include implementation history, root causes, TODOs, caveats, file paths, internal rationale or "why we did it".
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

`bun run lint guard` checks the rules no linter ships: no suppression comments, no environment-gated test skips, no new ignore entries, no `@public` tags, the strict TypeScript flags, the registered grit plugins, and the severity of the rules the quality contract depends on.

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
- Copy-paste is a bug waiting to happen: the duplication budget is 1% (`bun run lint duplicates duplicates-strict`). Extract the shared part instead of cloning it.

## Code

- Flat, imperative code. No speculative abstractions, no deep nesting.
- DTOs come from `Static<typeof Schema>`; DB rows from `$inferSelect` or `InferTable`. Use library types instead of hand-rolling them.
- `exactOptionalPropertyTypes` is on: an optional property that can receive an explicit `undefined` is typed `foo?: T | undefined`.
- Prefer the Drizzle query builder (`client.select`, `insert`, `update`, `delete`) and its `sql` template with schema-bound identifiers. A hand-written SQL string, or a direct `client.run(...)` / `client.all(...)` call with a `sql` template, is the last resort: use it only when Drizzle cannot express the query, or when a measured benchmark proves the raw form is faster. When it stays, interpolate every table and column from `schema` (never spell table/column names as string literals) and add a comment explaining why the raw form is required.
- Biome owns formatting. Don't hand-format.

## Architecture

- Layers: `api/` (HTTP transport) calls `services/` (use cases), which call `repositories/` (data access). `modules/` (feature engines: streaming, scanner, images, subtitles, downloads, …), `workers/` (background jobs) and `plugins/` (the plugin runtime) sit beside the services and call repositories and services directly. `system/`, `integrations/`, `config/` and `utils/` are the base everything builds on. Use `betterAuthApi.*`, not `auth.api.*`.
- There are no ports and no `wiring/` folder: a module, a worker or a supervisor imports the repository or service it needs. Import cycles are caught by oxlint (`import/no-cycle`, part of `bun run lint`); fix a cycle by moving the shared code down, never by adding an indirection.
- A worker definition (`workers/definitions/**`) exposes its enqueue helper, and features import that helper. When the worker's handler needs the feature back, the handler loads it lazily (`await import(...)`) — a dynamic import is not a cycle edge.
- Runtime supervisors (`system/`: resource allocator, server rescue, shutdown) and the library watcher are imported by almost everything, so they never import upward. The composition root `src/index.ts` hands them what they report to or call: `registerActiveStreamsProvider`, `registerAlertListener`, `registerStateListener`, the watcher's `registerScanner`/`registerLibraryScanner`, and the ordered `Shutdown` steps. A module never registers itself at import time.
- The one integration callback is Better Auth's own user write (`integrations/better-auth/better-auth.ports.ts`), registered by `registerAuthListeners()` in `services/auth/auth.service.ts` at boot (and in `tests/test.preload.ts`).
- Errors: throw `DomainError(category, message, { code, params })`. The message is for logs. API responses carry the code and params, never user-facing text.
- No `new X()` at module scope in a module that can sit in an import cycle (TDZ). Use a lazy getter or a callback registration.
- `detach()` takes only promises that cannot reject. A fire-and-forget task catches and logs its own errors before it is detached.
- Repository methods that look identical often aren't: most repositories override `findById` or `findByPrimaryId` to hydrate relations. Check for overrides before deduplicating.
- A projection (`parseFields({ fields: "..." })`) must list every field its consumer reads. Type the consumer from the repository's return type, never from a hand-written interface with optional fields: an optional field hides a column the query never selected.

### Services

- A feature too big for one file is a folder of plain functions grouped by concern (`reads`, `writes`, `markers`, …) plus a facade that is a plain object of those functions (`export const mediaService = { getAll, getById, … }`). The facade owns no logic and no state.
- The functions report through one shared `SafeExecuteContext` in `<feature>.logger.ts` (`runSafely(mediaFilesLog, "op", …)`). Never thread a `state` parameter or pass a sibling function in as a callback; call it.
- A class is for real per-instance state or injected collaborators (`UpdateInstallService`, `PluginManager`, `MetadataProcess`). A constructor `dependencies` object is a test seam for what leaves the process (ffmpeg, providers, the clock), not for repositories: tests run against the real database.

### Plugin extension points

Everything core lets a plugin observe or change goes through `system/extensions/`:
- `plugin.events.ts` — `pluginEventBus.publish(name, payload)` / `emit` after something happened. Fire-and-forget, time-boxed per handler.
- `plugin.hooks.ts` — `pluginHookBus.run(name, candidate)` before core acts. Each hook gets a frozen candidate and returns a replacement; `rejectPluginHook()` stops the action. To open a hook point, add its candidate type to `PluginHookCandidates` and call `run` where core is about to act; the call site validates what came back, because only it knows which fields a plugin may change.
- `plugin.access.ts` — `pluginAccessBus.check(context)` for allow/deny decisions (stream access today).

Plugins reach data through services, never repositories, so a plugin write passes the same checks, events and hooks as a core write. The hook points planned for 1.4.0 are listed in `TODO.md`.

## Layout and naming

This is the agreed layout. Put new code where it belongs. Don't create a new top-level folder in `src/`, and don't add a loose file to the `src/` root (only `src/index.ts`), without asking the user first.

```
src/
├── index.ts          entry point and composition root: boot sequence, HTTP app, shutdown order
├── api/              HTTP transport: Elysia server — routes (*.routes.ts), middleware, schemas, web UI serving, HTTP helpers
├── services/         use cases: one folder per feature (admin, auth, catalog, libraries, media, playback, plugins, trickplay, ...)
├── repositories/     data access: one repository per entity; readers (*.reader.ts) for large cross-entity reads; queries return DTOs
├── modules/          feature engines: streaming, scanner, images, subtitles, trickplay, downloads, realtime, metadata-sidecars, recognition
├── plugins/          plugin runtime: loader, lifecycle, catalog, capability implementations
├── workers/          background job runtime and job definitions
├── system/           runtime supervisors (resource allocator, server rescue, shutdown, data directories) and extensions/ (plugin event, hook and access buses)
├── integrations/     external processes and services: ffmpeg, ffprobe, sharp, better-auth, drizzle-orm (schemas, relations, migrations, factory, query building)
├── config/           env, server settings (config/server/), system settings, version, host resource service (system-resources.service), worker id categories, rate-limit overrides
└── utils/            pure helpers; no application dependencies
```

- Server settings live under `config/server/`, not in a separate top-level folder.
- Each folder has one responsibility. Place a file by the feature that uses it, not by its kind ("service", "helper").
- Biome enforces the boundaries that carry a rule (`style/noRestrictedImports` in `biome.json`, alias imports only). Each source file falls under exactly one override:
  - Nothing imports `api/`. `api/` itself doesn't import `repositories/`, `workers/`, `integrations/`, `drizzle-orm` or `better-auth`: a read, a job enqueue and a framework call go through the service that owns them.
  - `services/`, `modules/`, `workers/` and `system/` don't import `elysia`, `drizzle-orm` or `better-auth`.
  - `plugins/` doesn't import `repositories/`, the database factory or schema, `elysia`, `drizzle-orm` or `better-auth`.
  - `repositories/` doesn't import `api/`, `services/`, `modules/`, `plugins/`, `workers/` or `system/`. It is the leaf of the application, so a type a repository reads or returns is declared in the repository.
  - `integrations/` doesn't import any application layer; `config/` and `utils/` depend on each other only.
  - Relative imports are not checked. Use `@/` for imports across folders.
- Inside `integrations/drizzle-orm/`, the database layers are separate:
  - `query/` holds generic building blocks that know no feature: table access, query parsers (`parsing/`), keyset pagination (`keyset/`), transactions, prepared statements.
  - `utils/` holds helpers tied to a domain (joins, stable keys, media projections).
  - `schemas/`, `relations.schema.ts`, `migrations/` and `database.factory.ts` hold the schema, the relation graph, the migrations and the connection factory.
- Repositories live in `repositories/`: one per entity, with its simple relation reads (`metadata-relations/`) and the domain writers they share (`provider-entity-sync.writer.ts`, `named-entity-repository.factory.ts`). Large cross-entity reads, such as recommendations, live in `*.reader.ts` files there. They return DTOs.
- A repository never sees an HTTP concept. The audit log, for example, stores flat columns; the caller context (`services/admin/audit-context.types.ts`) is flattened by the audit service before it reaches the repository.
- `config/system-resources.service.ts` stays in `config/`, although it reads host CPU and RAM at runtime: `integrations/` and `utils/` import it, and they can't import `system/`.
- Inside `services/catalog/metadata/`, group files by responsibility (`refresh/`, `process/`, `records/`, `providers/`). `metadata.service.ts` stays the facade. Don't group by file type (`service/`, `metadata-process/`).

### File names

- A file is `<subject>.<role>.ts`, where the role suffix says what the file does. Reuse the existing suffixes: `service`, `repository`, `schema`, `routes`, `reader`, `writer`, `mapper`, `validator`, `guard`, `middleware`, `cache`, `factory`, `runtime`, `adapter`, `store`, `runner`, `scheduler`, `policy`, `manager`, `loader`, `parser`, `builder`, `registry`, `utils`, `types`, `constants`, `config`, `definitions`, `bench`, `resolver`, `strategy`, `publisher`, `importer`, `tracker`, `pipeline`, `cleaner`, `extractor`, `watcher`, `operation`, `limiter`, `aggregator`, `errors`, `failures`, `environment`, `plugin`, `scanner`, `processor`, `matcher`, `logger`, `recorder`, `monitor`, `initializer`, `reaper`, `seeker`, `coordinator`, `lookup`, `waiter`, `selector`, `locator`, `walker`, `exporter`, `eviction`, `diagnostics`, `indexer`, `fetcher`, `hardener`, `fanout`, `projection`, `allocator`, `connection`, `installer`, `history`, `report`, `ports`, `events`, `hooks`, `access`. Test-only helpers use `.helper.ts` or `.fixture.ts`, scripts use `.script.ts`, and the preload is `tests/test.preload.ts`.
- Don't invent a new suffix without asking. Don't use `.common`, `.helpers`, `.misc`, `.validation` (use `.validator`), `.schemas` (use `.schema`) or `.definition` (use `.definitions`).
- The only files without a role suffix are `index.ts` entry points and barrels.
- A test file is `<subject>.test.ts`, named after the module it covers; a second file for one module names the behavior (`media-files.reassign.test.ts`).

### Lifecycle

Know when a piece of code runs before you put it somewhere.

| Folder                      | When it runs                                                                                        | Rule                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `config/`                   | read at boot; system settings read through a cache; the resource monitor runs from boot to shutdown | a write invalidates the cache; the monitor timer is `.unref()` and cleared at shutdown |
| `integrations/drizzle-orm/` | opened and migrated at boot                                                                         | closed late in shutdown, after everything that writes to it                            |
| `system/`                   | the resource allocator and server rescue timers start at boot                                       | `.unref()` and cleared at shutdown                                                     |
| `plugins/`                  | loaded at boot; installed or updated while running                                                  | unloaded before the database closes                                                    |
| `workers/`                  | scheduler and pools start after the database                                                        | stopped before the database closes                                                     |
| `modules/`                  | started by `services/` and `workers/`                                                               | ffmpeg processes killed at shutdown                                                    |
| `services/`                 | per request only (use cases)                                                                        | no global mutable state                                                                |
| `repositories/`             | per request only (data access)                                                                      | no global mutable state beyond bounded caches                                          |
| `api/`                      | per request only (HTTP transport)                                                                   | no global mutable state                                                                |

Shutdown order (the `shutdownSteps` list in `src/index.ts`): realtime, http, library-watchers, resource-allocator, server-rescue, workers, download-sweeps, streaming, ffmpeg, plugins, database. Intake stops first, and the database closes last.

Before you add or move a file, check this section. If no folder fits, ask the user instead of creating one. Moves and renames are refactors and get no CHANGELOG entry.

## Schema and migrations

- The schema, relations and migrations live in `src/integrations/drizzle-orm/` (`migrations/`).
- A new table that references another table must add its relations to `src/integrations/drizzle-orm/relations.schema.ts` in the same change — both the owning side and the inverse (`r.one`/`r.many`) where the domain traverses it. A schema is never left out of the relation graph.
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

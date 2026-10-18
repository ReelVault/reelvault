---
paths:
  - "**/*.test.ts"
  - "tests/**"
---

# Testing

A test earns its place by failing when a behavior that matters breaks. Keep the suite small enough to read as a specification. More tests do not mean more safety.

## Write

- **Boundary**: call the real route with `app.handle` on the test SQLite database. One test checks the status, the error code, the response shape and the stored row.
- **Security and ownership**: another user's or profile's resource is refused; paths can't leave their folder; secret fields never appear in responses or exports; the last administrator can't be locked out.
- **Data integrity**: batches are all-or-nothing; idempotency and dedupe keys hold; caches are invalidated after writes; transactions roll back; concurrency limits hold.
- **Regressions**: one test per fixed bug that fails without the fix, named after the behavior.
- **Branchy pure logic** (parsers, matchers, ranking, backoff, path guards, argument builders): `test.each` over the input variants.
- **Resilience**: one failing item in a batch doesn't stop the others, and its outcome is reported by code.

## Don't write

Each item says what to write instead.

- **Pass-through**: a stub echoed back, or a call asserted with the arguments it was given. Assert the returned value or the stored row.
- **Tautology**: an expected value recomputed with the logic under test. Use a literal.
- **Call count or call order on collaborators**: assert the outcome. Keep a call assertion only when the order is the invariant (for example, the cache is invalidated before the write becomes visible), and say so in the title.
- **Existence**: `.compile()`, `toBeDefined()`, `toBeTruthy()`, `typeof x === "function"`, a bare `not.toThrow()`. Assert the value the code produces.
- **Constants and metadata**: label lists, format tags, unit strings. Assert default values only when a behavior depends on them.
- **Third-party behavior**: TypeBox, Elysia, Drizzle, Better Auth, Bun.
- **Schema-enforced rules**: per-field rejections (ranges, lengths, unknown keys). One boundary test per route shows the schema is wired. New rules go into the schema.
- **Mapping only**: DTO shaping with no invariant behind it.
- **Duplicates**: the same behavior in two files. Keep it in the file that owns the code.
- **Negative complements**: "X does not happen when Y" next to "X happens when Z".
- **Assertion-free tests**: code run for coverage with nothing checked, or a failure left to a framework's uncaught exception.
- **Swallowed failures**: `try`/`catch` around an assertion, or assertions inside callbacks that may never run.
- **Snapshots** of output that break on any refactor.
- **Hidden coupling**: data created by another test or file (use per-test fixtures), or the developer's machine (home paths, time zone, locale). Passing runs print nothing.
- **Titles that promise more** than the assertions check.

## Shape

- **Title**: one sentence in domain language, stating the condition and the outcome: `refuses to restore while a stream is active`. Don't use "works", "handles" or "should".
- **Structure**: arrange, act, assert. One behavior per test. Set up only what it needs; shared setup goes in `tests/helpers`.
- **Assertions**: assert outcomes (response, row, emitted payload, returned value). Compare only the fields the behavior is about, and don't depend on order in unordered collections. Assert errors by `code` and `category`, never by message text:
  - sync: `expect(() => fn()).toThrow(expect.objectContaining({ category, code }))`
  - async: `await expect(promise).rejects.toMatchObject({ category, code })`
  - an error thrown by a stub: `rejects.toBe(error)`, by identity
- **Async**: always `await` `.rejects` and `.resolves`. An un-awaited assertion can pass without running.

## Dependencies

- In-process code runs against the real SQLite test database and the real app.
- Application tests seed and read rows through `tests/helpers/rows.fixture.ts`. They don't import `drizzle-orm` or the schema, and Biome enforces this. Add a fixture there when a test needs a table it doesn't have yet.
- Mock only what leaves the process: network, ffmpeg and ffprobe processes, clock, external plugins. If the mock setup is longer than the assertion, use the real dependency or move the test up a layer.
- No environment-gated tests. The suite requires `ffmpeg` and `ffprobe`.
- Private members: don't read them through `Reflect` or type guards. Test through the public entry point, or add an injectable seam (a constructor argument such as a metrics reader or a lag sampler, as in `ResourceAllocator` and `ServerRescueService`). The one exception is a timer-driven callback with no public entry point: call it through a single helper whose comment names that reason.

## Isolation

- A file must not change another file's result. A module-scope `spyOn` is restored in `afterAll`; a per-test stub is restored in `afterEach` (`stubMethod` in `tests/helpers/method-stub.helper.ts`).
- Global runtime state (system settings, caches, `globalThis`) is reset in `afterEach`.
- Import-time side effects that reach the database are a bug in the source, not something a test hides.

## Self-check

Before you finish a test, break the code path it covers (flip one condition or change one code), confirm the test fails, then restore the code. A test that still passes protects nothing.

## Removing tests

- Delete a test that matches "Don't write" and guards no behavior. Rewrite it if it guards one.
- Never delete a failing test to get green. A failing test is a bug until proven otherwise.
- Removing or reorganizing tests is not logged in the CHANGELOG.

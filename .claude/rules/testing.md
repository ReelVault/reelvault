---
paths:
  - "**/*.test.ts"
  - "tests/**"
---

# Testing

A test earns its place by failing when a behavior that matters breaks. Keep the suite small enough to read as a specification. More tests do not mean more safety.

`AGENTS.md` holds the contract. This file holds the long form: what each rule means, why it exists, and what to write instead.

## The six gates

Every test case passes all six. A case that fails one of them is rewritten or deleted, not merged.

### 1. Provenance — the expected value is a fact

The expected side of an assertion is a **fact about the behavior**:

- a literal,
- a row read back from the database,
- bytes read from the real system,
- a value an external specification fixes (RFC 9110 for ranges, RFC 4122 for UUIDs, a real ffmpeg banner, an HTTP status, a MIME type).

It is never a **recomputation of the subject**. The two forms look different and fail the same way:

**The same function** — the expected side calls the function under test:

```ts
// The expected value is computed by the code under test. If both sides are
// wrong in the same way, the test stays green.
expect(buildDecodeOnlyArgs(hw)).toEqual(hardwareDecodeArgs(hw));
```

**The same helper** — the expected side calls a helper the code under test also calls:

```ts
// The pipeline and the test both call createImageStableKey, so a broken key
// format is invisible: the test only proves the helper was called.
const STABLE_KEY = createImageStableKey({ ownerStableKey: "owner-key", imageType: "poster", sourceHash });
expect(result.stableKey).toBe(STABLE_KEY);
```

The helper's own correctness is then never verified. A helper that produces the expected value needs its own test, with literals:

```ts
expect(result.stableKey).toBe("poster-owner-key-<sha256 hex>");
```

The same rule applies to a constant: **a constant used as the expected value is built from literals**, not from a call into the subject.

A helper that reads the world — the filesystem, the network, the database — is a fact, not a recomputation. Reading a file back to prove it was not rewritten stays:

```ts
const before = await readFile(path);
await exporter.saveTitleArtwork(...);
expect(await readFile(path)).toEqual(before); // the file was not rewritten
```

### 2. Sensitivity — would it fail?

Before you finish a test, break the code path it covers: flip one condition or change one code, confirm the test fails, then restore the code. A test that still passes protects nothing.

`bun run mutation` measures this across the suite. It rewrites the implementation and counts the mutants the suite kills. It reports **sensitivity, not correctness** — a suite can kill every mutant and still assert the wrong value, because mutation testing cannot tell an intended change from an unintended one. Use it to find dead weight, never as a certificate.

### 3. Outcome — assert what happened, not how

Assert the outcome: the returned value, the stored row, the response body, the emitted payload, the written file.

| Never | Instead |
|---|---|
| `expect(repo.findById).toHaveBeenCalledWith(id)` | the row the repository returns |
| `expect(mock.save).toHaveBeenCalledTimes(1)` | the stored row |
| `expect(result).toBe(stubReturn)` | the value the service produced from it |
| `expect(spy).toHaveBeenCalledWith(url, opts)` | the response the caller received |

A call assertion is allowed only when the call itself is the invariant — the cache is invalidated before the write becomes visible, the lock is held across the section — and the title says so.

### 4. Ownership — the file owns the code

A test file under `src/` exercises a module from its own folder. A test that covers another area's code belongs to that area:

- the coverage map lies about what is protected,
- the test reads as noise in the folder it sits in,
- the next agent moves the code and the test stays behind.

The cross-cutting suites in `tests/` are the exception: they exercise the whole application on purpose.

### 5. Independence — the machine and the build

A test that passes on your box and fails on the CI runner is a broken test, not a flaky one. Five things leak the environment into a test.

**The host.** What the machine has — a GPU, a DRM render node, a core count, a measured CPU speed — is not an input the test controls. The code that consults the host takes the answer as a parameter, so the test passes it:

```ts
// The accelerator is an input, not a lookup.
const args = buildTranscodeVideoArgs(decision, config, hw("nvenc"), toneMap("none"));
```

When the production code reads the host itself, the test replaces the module instead:

```ts
mockModuleWithRealExports("@/integrations/ffmpeg/ffmpeg.capabilities", {
	getEffectiveHwaccel: () => SOFTWARE_HWACCEL,
});
```

A test may not call a probe that reads the detected capabilities — `getEffectiveHwaccel`, `getFfmpegCapabilities`, `resolveEffectiveHwaccel`, `getDetectedDriDevice`. The one exception is the test that owns the module declaring them.

**The subject reads the host too.** A test that exercises a *detection* inherits every host read inside the subject, even the ones the test never touches. The auto-detection of a DRM-backed accelerator needs a `/dev/dri` node; the software encoder's preset, resolution cap and x264 lookahead scale with the measured CPU speed. Pin those inputs — mock the probe the subject calls, or stub the speed factor — or the test passes on a desktop and fails on a CI runner.

**The build.** The suite runs against whatever ffmpeg the machine has: upstream ffmpeg, jellyfin-ffmpeg, or a minimal build. They differ in the filters and encoders they advertise, so a test that asserts on the *detected* set is asserting on the build. The decisions that depend on the build are tested with literal sets instead:

```ts
// jellyfin-ffmpeg ships tonemapx, upstream ffmpeg ships zscale+tonemap.
expect(resolveToneMappingMethod(new Set(["scale", "tonemapx", "zscale", "tonemap"]))).toBe("tonemapx");
expect(resolveToneMappingMethod(new Set(["scale", "zscale", "tonemap"]))).toBe("zscale");
```

The same holds for the encoder set: a build without `h264_nvenc` must fall back to software, and a test proves it with a literal encoder set, not with whatever the host advertises.

**The clock.** A test that measures elapsed time may only compare it against a bound the test itself pins — a stubbed constant, never a wall-clock literal and never a host-scaled default:

```ts
// The cushion is scaled by the host's speed, so it is pinned here.
const cushion = stubMethod(systemResourcesService, "scaledTimeoutMs", () => CUSHION_MS);
```

A bound taken from the host's speed factor or from a hard-coded millisecond count is a race against the runner: it passes on a fast machine and fails on a loaded one.

**The run.** Every test file in one `bun test` run shares one process, so process-wide state carries over from file to file. The rate limiter's buckets are the clearest case: a file that sends a few hundred requests from one address spends the budget that the next file's requests draw on. A file that exhausts such a budget clears it in `afterAll`; a file that depends on one clears it in `beforeEach`. A file that passes alone is no evidence for the run: check it with the full suite.

### 6. Reality — the case is one the product produces

The input is a case the product really handles: a real file, a real row, a real request, a value a user or an external provider sends. The expected value is what the behavior should produce for that input, settled from the behavior before the code is consulted.

A fixture shaped to what the implementation does today passes by accident, and it hides the bug the test exists to catch. Replace it with a real case.

When a test fails, read the production code first:

- Fix the function when it is wrong, and keep the assertion.
- Change an expected value only when the old one contradicts a written fact: a specification, a documented behavior, a reported bug. Name the fact in the commit or the CHANGELOG.
- Never move an expected value to what the new code prints because the code now does something else. That ships the defect with a green test attached.

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
- **Tautology**: an expected value recomputed with the logic under test, or with a helper the logic under test also calls. Use a literal.
- **Call count or call order on collaborators**: assert the outcome. Keep a call assertion only when the order is the invariant, and say so in the title.
- **Existence**: `.compile()`, `toBeDefined()`, `toBeTruthy()`, `typeof x === "function"`, a bare `not.toThrow()`. Assert the value the code produces.
- **A loose bound**: `toBeGreaterThan(0)`, `toBeGreaterThanOrEqual(1)`. Any value passes.
- **Constants and metadata**: label lists, format tags, unit strings. Assert default values only when a behavior depends on them.
- **Third-party behavior**: TypeBox, Elysia, Drizzle, Better Auth, Bun, SQLite, the ffmpeg CLI's own output format.
- **Schema-enforced rules**: per-field rejections (ranges, lengths, unknown keys). One boundary test per route shows the schema is wired. New rules go into the schema.
- **Mapping only**: DTO shaping with no invariant behind it.
- **Duplicates**: the same behavior in two files. Keep it in the file that owns the code.
- **Negative complements**: "X does not happen when Y" next to "X happens when Z".
- **Assertion-free tests**: code run for coverage with nothing checked, or a failure left to a framework's uncaught exception.
- **Swallowed failures**: `try`/`catch` around an assertion, or assertions inside callbacks that may never run.
- **Snapshots** of output that break on any refactor.
- **Hidden coupling**: data created by another test or file (use per-test fixtures), or the developer's machine (home paths, time zone, locale). Passing runs print nothing.
- **Titles that promise more** than the assertions check.
- **Shaped fixtures**: input built to fit what the implementation does today, not a case the product produces (gate 6).
- **The subject twice**: an expected value that is another output of the function under test, written as a call or held in a variable. Pin both sides to literals.

## Shape

- **Title**: one sentence in domain language, stating the condition and the outcome: `refuses to restore while a stream is active`. Don't use "works", "handles" or "should". A title that names a mechanism (a cache, a database lookup, a symlink dereference, a retry) needs an assertion that observes that mechanism; otherwise the title names only the outcome.
- **Structure**: arrange, act, assert. One behavior per test. Set up only what it needs; shared setup goes in `tests/helpers`.
- **Assertions**: assert outcomes (response, row, emitted payload, returned value). Compare only the fields the behavior is about, and don't depend on order in unordered collections. Assert errors by `code` and `category`, never by message text:
  - sync: `expect(() => fn()).toThrow(expect.objectContaining({ category, code }))`
  - async: `await expect(promise).rejects.toMatchObject({ category, code })`
  - an error thrown by a stub: `rejects.toBe(error)`, by identity
- **Async**: always `await` `.rejects` and `.resolves`. An un-awaited assertion can pass without running.

## Dependencies

- In-process code runs against the real SQLite test database and the real app.
- Application tests seed and read rows through `tests/helpers/rows.fixture.ts`. They should not import `drizzle-orm` or the schema. Biome does not enforce this for tests: its layer restrictions exclude `*.test.ts`. Several existing tests still import the schema directly, and new ones should not. Add a fixture there when a test needs a table it doesn't have yet.
- Mock only what leaves the process: network, ffmpeg and ffprobe processes, clock, external plugins. If the mock setup is longer than the assertion, use the real dependency or move the test up a layer.
- No environment-gated tests. The suite requires `ffmpeg` and `ffprobe`.
- Private members: don't read them through `Reflect` or type guards. Test through the public entry point, or add an injectable seam (a constructor argument such as a metrics reader or a lag sampler, as in `ResourceAllocator` and `ServerRescueService`). The one exception is a timer-driven callback with no public entry point: call it through a single helper whose comment names that reason.

## Isolation

- A file must not change another file's result. A module-scope `spyOn` is restored in `afterAll`; a per-test stub is restored in `afterEach` (`stubMethod` in `tests/helpers/method-stub.helper.ts`).
- Global runtime state (system settings, caches, `globalThis`) is reset in `afterEach`. Process-wide budgets are shared by every file in a run, so a suite that spends one clears it in `afterAll` (`prepareSecuritySuite()` in `tests/security/security.helper.ts` does this for the security suites), and a file that depends on one also clears it in `beforeEach`.
- Import-time side effects that reach the database are a bug in the source, not something a test hides.

## Self-check

Before you finish a test, break the code path it covers (flip one condition or change one code), confirm the test fails, then restore the code. A test that still passes protects nothing.

Then read the diff of the test the way a reviewer who did not write it would: if the expected value could have been produced by the implementation itself, the test proves nothing. Replace it with a literal.

In the report of the change, name the mutation you used and the test it failed. A test you cannot tie to a failing mutation has not been checked.

## The gate

`bun run lint:tests` fails on:

- an expected value recomputed with the code under test or with a helper it also uses,
- an expected value that is a constant the code under test defines,
- a case whose only assertion proves something exists,
- a case whose only assertion is that a collaborator was called,
- a bare `toThrow()` that accepts any error,
- a case whose only assertion is a bound any value passes,
- a test file under `src/` that exercises no module from its own folder,
- a test that calls a probe of the host's detected capabilities instead of mocking it.

`bun run lint` runs it. Fix the assertion, not the rule.

The gate matches the static forms above only. It cannot see a variable that holds an earlier output of the subject, a shaped fixture, or a fact that is wrong. Reviewers and the mutation check in *Self-check* cover those.

## Removing tests

- Delete a test that matches "Don't write" and guards no behavior. Rewrite it if it guards one.
- Never delete a failing test to get green. A failing test is a bug until proven otherwise.
- Removing or reorganizing tests is not logged in the CHANGELOG.

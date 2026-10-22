# TODO

Work found during the 1.3.2 code review that was deliberately **not** done in 1.3.2, plus the plan for
the 1.4.0 plugin hook points. Every item is written so that someone who has not seen the review — a
person or an AI agent — can pick it up without asking.

Before you start any item:
- Read `AGENTS.md` (architecture, layer rules, test gates, Definition of Done) and, for tests,
  `.claude/rules/testing.md`. The Definition of Done is `bun run format`, `bun run lint`, `bun run test`.
- 1.3.2 must not change the SDK (`@reelvault/sdk`, a separate repository: https://github.com/ReelVault/sdk)
  or the shape of data the API returns. That is why the items in part 1 wait for a release that bumps the SDK.
- An SDK change is made in the SDK repository, published, then `@reelvault/sdk` is bumped in this
  repository's `package.json` (and in the website and plugin repositories that consume it).
- A behavior change gets a `CHANGELOG.md` entry under the newest untagged heading.

---

## Part 1 — Deferred changes to returned data or to the SDK contract

### 1. The insights range `all` covers only the last 365 days

**Where:** `src/services/users/watched-history.service.ts`, the constant
`RANGE_DAYS: Record<InsightsRange, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: 365 }`
and its use in the insights method (around `const days = RANGE_DAYS[range]`). The route is
`GET /v1/me/insights?range=…` (SDK type `InsightsRange` in `@reelvault/sdk/common`, values
`"7d" | "30d" | "90d" | "1y" | "all"`).

**Problem:** `range=all` returns exactly the same numbers as `range=1y`. A profile with three years of
history sees only the last one: total minutes, top movies and shows, genre distribution and the hourly
heatmap all stop at 365 days. The method also computes a "previous period" of the same length
(`previousSince = since - days`) to show trends; for `all` that previous period is meaningless.

**Why deferred:** fixing it changes the values clients receive for `all` (and the trend fields), which
is a change to returned data.

**Proposed change:**
1. For `all`, take `since` from the profile's first `watched_history.watched_at` (one indexed query —
   the `history_profile_watched_id_idx` index on `(profile_id, watched_at, id)` serves `MIN(watched_at)`
   per profile), or simply use the epoch.
2. Skip the previous-period aggregate for `all` and return the trend fields as `null` (or omit them).
   Check `ProfileInsightsSchema` in the SDK: if the trend fields are not nullable today, the SDK has to
   make them nullable first — that is the SDK part of this item.
3. The insights cache (`clearProfileInsights`) is keyed by profile and range; nothing changes there.

**Acceptance:** a test in `src/services/users/` seeds history rows older than 365 days for one profile
(use `tests/helpers/rows.fixture.ts`) and asserts that `range=all` counts them while `range=1y` does not,
with literal expected minutes.

### 2. Person biographies are always in the provider's default language

**Where:**
- SDK: `MetadataProvider.getPersonDetails?(externalId: string)` in `@reelvault/sdk/plugin` takes no
  options. Every other provider lookup takes `hints?: ProviderRequestHints` (`{ language?: string }`):
  `search`, `getDetails`, `getSeasonDetails`, `getEpisodeDetails`.
- Server: `fetchPerson(externalId)` in `src/plugins/capabilities/provider/catalog.service.ts` (cache key
  `${providerKey}:${externalId}` in `providerCaches().person`), called by `refresh()` in
  `src/services/catalog/people.service.ts`.

**Problem:** titles, seasons and episodes are fetched in the library's metadata language
(`resolveMetadataLanguage(metadataId)` in
`src/services/catalog/metadata/providers/library-metadata-language.resolver.ts`); 1.3.2 fixed the
refresh paths that forgot it. People cannot follow, because the SDK gives no way to pass a language,
so a Polish library shows Polish titles next to English biographies.

**Why deferred:** needs a new optional parameter in the SDK's provider interface.

**Proposed change:**
1. SDK: `getPersonDetails?(externalId: string, hints?: ProviderRequestHints)`. Optional, so existing
   providers keep working.
2. Server: `fetchPerson(externalId, language?)`, passing `{ language }` to the provider, and the
   language in the cache key (`${providerKey}:${language ?? ""}:${externalId}`) — otherwise two
   languages share one cached biography.
3. Decide which language a person gets. A person belongs to many titles in possibly different
   libraries. Recommended: the language of the library that holds most of the person's titles, falling
   back to the server's default metadata language; simpler alternative: the server default only.
   Write the choice down in the code comment.
4. Update the official TMDB provider plugin (plugins repository) to forward `hints.language`.

**Acceptance:** a test registers a real provider whose `getPersonDetails` records the hints it got and
asserts the stored biography for a person linked to a `metadataLanguage: "pl"` library. Do not stub the
provider service; register the provider the way `tests/plugins/provider.events.test.ts` does.

### 3. `jobs.enqueueMany` reports the batch's operation id on every handle

**Where:** `pluginJobsService.enqueueMany` in `src/plugins/capabilities/plugin.jobs.ts`. Each item may
carry its own `options.operationId`, which is honored when the job is stored
(`operationId: item.options?.operationId ?? opId`), but the returned handles are built as
`queuedItems.map((item) => ({ id: item.id, name, operationId }))` — always the batch's operation.

**Problem:** a plugin that put an item into its own operation receives a `PluginJobHandle` naming a
different operation, so tracking that job's progress through the handle follows the wrong operation.

**Why deferred:** it changes what a plugin receives in `PluginJobHandle.operationId`.

**Proposed change:** return each item's effective operation id:
`items.map((item, index) => ({ id: queuedItems[index].id, name, operationId: item.options?.operationId ?? operationId }))`.
First confirm `workerService.addItems` returns its results in input order (deduplicated items come
back as the existing job); if not, map by job id instead of by index. Document in the SDK that the
handle's `operationId` is per item.

**Acceptance:** a test in `src/plugins/capabilities/` enqueues two items, one with its own
`operationId`, and asserts both handles' `operationId` literals and the stored `worker_jobs` rows.

### 4. Plugin jobs can declare any number of attempts

**Where:** `pluginJobsService.register` in `src/plugins/capabilities/plugin.jobs.ts` passes
`attempts: job.options?.attempts` straight to `workerService.registerWorker`. Concurrency and timeout
are clamped right next to it (`clampPluginJobConcurrency`, `clampPluginJobTimeout` with
`MAX_PLUGIN_JOB_TIMEOUT_MS`); attempts are not. The retry loop is in
`src/workers/core/worker-pool.service.ts` (`if (item.attempts < item.maxAttempts)`).

**Problem:** a plugin can register a job with `attempts: 1_000_000`; a permanently failing job then
retries forever (bounded only by its backoff), occupying worker slots and filling the job history.

**Why deferred:** a cap changes behavior a plugin explicitly declared.

**Proposed change:** add `MAX_PLUGIN_JOB_ATTEMPTS` (suggested 25) next to `MAX_PLUGIN_JOB_TIMEOUT_MS`
and a `clampPluginJobAttempts` with the same shape as the other two (`Math.floor`, minimum 1). Mention
the cap in the SDK's `PluginJobOptions.attempts` doc comment and in the CHANGELOG.

**Acceptance:** a test registers a plugin job with `attempts: 1000` and asserts the registered
worker's `maxAttempts` is 25.

---

## Part 2 — 1.4.0: plugin hook points

Goal for 1.4.0: a plugin can observe and influence almost everything the server does — change
recommendation scores, refuse a login outside allowed hours, require an invitation code to register,
add providers, rewrite notifications. 1.3.2 prepared the infrastructure; this part lists what to add
and exactly where.

### What exists today

All extension points live in `src/system/extensions/`:

| Bus    | File                                   | Purpose                                                              | Today                                                                                 |
| ------ | -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Events | `plugin.events.ts` (`pluginEventBus`)  | _after_ something happened; fire-and-forget, each handler time-boxed | names and payloads come from the SDK's `PluginEventDataMap` (`@reelvault/sdk/plugin`) |
| Hooks  | `plugin.hooks.ts` (`pluginHookBus`)    | _before_ core acts; a hook returns a changed candidate or rejects    | `beforeArtifactCreate`, `beforeMediaRecognition`, `beforeMetadataSave`                |
| Access | `plugin.access.ts` (`pluginAccessBus`) | allow/deny decisions                                                 | `PluginAccessContext` with `resource: "stream"`, `action: "play"`                     |

How the hook bus runs a hook (`PluginHookBus.run(name, candidate)`): the candidate is
`structuredClone`d and deep-frozen; each registered hook runs in turn with
`{ candidate }`, under `serverConfig.plugins.runtime.hookTimeoutMs` (5 s); a returned object becomes
the next hook's (frozen) candidate, `undefined` keeps the current one; a thrown
`PluginHookRejection` (created by `rejectPluginHook(message)` in the SDK) aborts the chain and is
rethrown to the caller; any other error or a timeout is logged and that hook is skipped.

Events published today (SDK `PluginEventDataMap`): `plugin.enabled`, `plugin.disabled`,
`library.scan.started`, `library.scan.completed`, `media.file.discovered`, `media.file.ready`,
`media.file.unavailable`, `media.file.identified`, `media.file.technical-data-updated`,
`media.markers.updated`, `metadata.search.requested`, `metadata.saved`, `metadata.refreshed`,
`artifact.created`, `notification.created`, `playback.session.started`, `playback.session.ended`,
`playback.lifecycle.started`, `playback.lifecycle.progress`, `playback.lifecycle.stopped`,
`playback.progress.updated`.

### Prerequisite: map a hook rejection to an API error

Today nothing converts `PluginHookRejection` into a `DomainError`: it reaches the HTTP layer as an
unknown error and the client gets a 500. Before adding any hook that can reject (login,
registration, stream start), map it once — in `PluginHookBus.run` itself, so no call site can forget:
catch `PluginHookRejection` and throw
`new DomainError("forbidden", error.message, { code: "plugin.hook_rejected", params: { hook: name, plugin: pluginId }, cause: error })`.
The message is for logs; the client receives the code and params (AGENTS.md: API responses never
carry user-facing text). Check how `src/api/middleware/domain-errors.middleware.ts` maps the
`forbidden` category (it should be 403) and add one boundary test.

### How to add a hook point (the recipe)

1. **SDK** (sdk repository): add the candidate type and the registration method to the `hooks`
   capability (`host.hooks.beforeX(handler)`, next to `beforeArtifactCreate` in `plugin/hooks`). The
   candidate is plain data the plugin may change — never a database row or a class instance.
2. **Server, the bus:** add the candidate type to the `PluginHookCandidates` interface in
   `src/system/extensions/plugin.hooks.ts`. The bus is generic over that map; nothing else changes there.
3. **Server, the plugin host:** map the new SDK method in `buildHooksCapability` in
   `src/plugins/lifecycle/host/plugin-host.factory.ts` to
   `scope.subscribeHook(pluginId, "beforeX", handler)` (it already accepts any key of the map).
4. **Server, the call site:** right before core acts, `const candidate = await pluginHookBus.run("beforeX", original);`
   then **validate what came back** — only the call site knows which fields a plugin may change. Run the
   result through the same rules as client input (schema, allow-lists, ownership). Follow
   `assertValidArtifactCandidate` in `src/services/artifacts/media-artifacts.service.ts`, which also
   re-checks the content-type allow-list after the hook (a 1.3.2 fix: a hook could otherwise store
   `text/html`).
5. **Tests:** register a real hook on `pluginHookBus` (unsubscribe in `afterEach`); never stub the bus.
   Cover: the changed candidate is applied, an invalid change is refused with its error code, and a
   rejection reaches the caller as `plugin.hook_rejected`.
6. **Docs:** the plugin guide on reelvault.org and the CHANGELOG.

### How to add an event

1. SDK: add the name and payload to `PluginEventDataMap`.
2. Server: `pluginEventBus.publish("x.y", payload)` _after_ the change is committed (outside the
   transaction), so a plugin never observes a write that is rolled back. Payloads carry ids and
   small fields, not whole rows.
3. Test: subscribe with `pluginEventBus.on(...)` and assert the payload (see
   `tests/plugins/provider.events.test.ts`).

### How to widen access decisions

Extend `PluginAccessContext` in the SDK (`resource: "stream" | "download" | "subtitle"`, matching
`action` values) and call `pluginAccessBus.check(context)` at each new gate, the way
`src/modules/streaming/sessions/stream-access.guard.ts` does for streams.

### Hook and event map

"Proposed" means the name is a suggestion to settle in the SDK. Every function named here exists
under that name today.

| Area                      | Hook before (candidate → what a plugin can do)                                                                                                                                         | Event after                                                                                    | Call site                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration              | `beforeUserRegister`: `{ email, name, ip, headers }` → refuse (e.g. missing or invalid invitation code in a header), normalize the name                                                | `user.registered` (proposed)                                                                   | `register()` in `src/services/auth/auth.service.ts`. Every account creation (self-registration, admin, setup) goes through Better Auth's `databaseHooks.user.create` in `src/integrations/better-auth/better-auth.config.ts` (its `after` callback is wired by `registerAuthListeners()`); a `before` there catches all paths at once |
| Login                     | `beforeUserLogin`: `{ userId, email, ip, method: "password" \| "quick-connect" \| "api-key" }` → refuse (hours, country, device)                                                       | `user.logged-in`, `user.logged-out` (proposed)                                                 | `login()` and `logout()` in `src/services/auth/auth.service.ts`; `redeem()` in `src/services/auth/quick-connect.service.ts`; Better Auth `databaseHooks.session.create` covers every session                                                                                                                                          |
| Account security          | —                                                                                                                                                                                      | `user.password-changed`, `user.two-factor-changed` (proposed)                                  | `changePassword()` in `auth.service.ts`; `enable()` / `disable()` in `src/services/auth/two-factor.service.ts`                                                                                                                                                                                                                        |
| Account administration    | `beforeUserCreate` (admin): `{ email, name, role }` → refuse, adjust the role                                                                                                          | `user.created`, `user.updated`, `user.deleted`, `user.banned` (proposed)                       | `create()`, `update()` (ban/unban happen inside it), `delete()` in `src/services/admin/admin-users.service.ts`                                                                                                                                                                                                                        |
| Profiles                  | `beforeProfileCreate`: `{ userId, name }` → refuse (profile quota), adjust                                                                                                             | `profile.created`, `profile.deleted`, `profile.switched` (proposed)                            | `create()`, `delete()`, `switch()` in `src/services/users/profiles.service.ts`; admin path `createProfile()` in `admin-users.service.ts`                                                                                                                                                                                              |
| Stream start              | `beforeStreamInit`: the playback decision (mode, bitrate, audio/subtitle tracks) → change it within the client's capabilities, or refuse                                               | `playback.lifecycle.started` (exists)                                                          | `createPlaybackSessionInternal()` in `src/modules/streaming/sessions/session-lifecycle.service.ts`, after `selectPlayback()` and before the capacity slot is reserved — a refusal must not hold a slot                                                                                                                                |
| Stream access             | `pluginAccessBus` (exists; widen `resource` to `download`, `subtitle`)                                                                                                                 | —                                                                                              | `assertActiveStreamAccess()` in `src/modules/streaming/sessions/stream-access.guard.ts`; download routes in `src/api/routes/v1/downloads.routes.ts` via `src/modules/downloads/downloads.service.ts`                                                                                                                                  |
| Seeking                   | `beforeSeek`: `{ sessionId, position }` → clamp, refuse                                                                                                                                | `playback.seeked` (proposed)                                                                   | `seek()` in `src/modules/streaming/seeking/seek.service.ts`                                                                                                                                                                                                                                                                           |
| Pause, resume, completion | —                                                                                                                                                                                      | `playback.paused`, `playback.resumed`, `playback.completed` (proposed)                         | `execute()` in `src/services/playback/heartbeat.service.ts`; `updatePlaybackProgress()` in `src/services/playback/playback-progress.service.ts` (the `completesTitle` branch marks a title watched)                                                                                                                                   |
| Recommendations           | `beforeRecommendationsRank`: `{ profileId, items: [{ metadataId, score }] }` → own multipliers, exclusions, injected titles (validate that every id exists and the profile may see it) | —                                                                                              | `getRecommendations()` in `src/services/users/discover.service.ts`: after `scored.sort(...)`, before `applyDiversityFilter(...)` — re-sort after the hook                                                                                                                                                                             |
| Trending                  | `beforeTrendingRank`: `{ items: [{ metadataId, score }] }`                                                                                                                             | —                                                                                              | `buildTrending()` in `src/services/users/discover-recommendations.service.ts`, before `scored.sort(...)`                                                                                                                                                                                                                              |
| File recognition          | `beforeMediaRecognition` (exists)                                                                                                                                                      | `media.file.identified` (exists)                                                               | `recognizeWithPluginHooks()` in `src/modules/recognition/recognition.service.ts`                                                                                                                                                                                                                                                      |
| Metadata save             | `beforeMetadataSave` (exists)                                                                                                                                                          | `metadata.saved`, `metadata.refreshed` (exist)                                                 | `src/services/catalog/metadata/providers/metadata-create.utils.ts`; `src/services/catalog/metadata/refresh/metadata-refresh.runtime.ts` (`transformMetadata`)                                                                                                                                                                         |
| Search                    | `beforeSearch`: `{ term, limit }` → rewrite the query (synonyms, transliteration); `afterSearchRank`: `{ titles, people, collections, genres }` → reorder or filter                    | `metadata.search.requested` (exists)                                                           | `searchGlobal()` in `src/services/catalog/metadata/records/reads.reader.ts` (the service entry); the query itself is `searchGlobal()` in `src/repositories/metadata-search.reader.ts`                                                                                                                                                 |
| Artifacts                 | `beforeArtifactCreate` (exists)                                                                                                                                                        | `artifact.created` (exists)                                                                    | `write()` in `src/services/artifacts/media-artifacts.service.ts`                                                                                                                                                                                                                                                                      |
| Offline downloads         | `beforeDownloadQueue`: `{ profileId, mediaFileId, quality }` → refuse (quota, schedule), change the quality                                                                            | `download.completed`, `download.failed` (proposed)                                             | `prepare()` in `src/modules/downloads/downloads.service.ts`; `finalizeDownload()` in `src/modules/downloads/download.runner.ts`                                                                                                                                                                                                       |
| Notifications             | `beforeNotificationCreate`: `{ userId, profileId, type, title, message, data }` → rewrite, mute (return a "skip" marker the call site honors)                                          | `notification.created` (exists)                                                                | `create()` and `createForAdministrators()` in `src/services/notifications/notifications.service.ts`                                                                                                                                                                                                                                   |
| Watchlist and ratings     | —                                                                                                                                                                                      | `watchlist.changed`, `rating.changed` (proposed)                                               | `add()`, `remove()`, `bulkUpdate()`, `clear()` in `src/services/users/watchlist.service.ts`; `rate()`, `delete()` in `src/services/users/user-ratings.service.ts`                                                                                                                                                                     |
| Libraries                 | `beforeLibraryCreate`: `{ name, type, paths }` → refuse (allowed roots), adjust                                                                                                        | `library.created`, `library.deleted` (proposed); `library.scan.started` / `.completed` (exist) | `createLibrary()`, `deleteLibrary()` in `src/services/libraries/crud.service.ts`                                                                                                                                                                                                                                                      |
| Server settings           | `beforeSettingsUpdate`: `{ changes }` → validate values a plugin owns, refuse                                                                                                          | `settings.updated` (proposed)                                                                  | `updateSettings()` in `src/services/admin/system-settings.service.ts` (`importSettings()` goes through it)                                                                                                                                                                                                                            |
| Media files               | —                                                                                                                                                                                      | `media.file.reassigned`, `media.file.deleted` (proposed)                                       | `src/services/media/media-files/maintenance/reassign.service.ts`, `remove.service.ts`                                                                                                                                                                                                                                                 |

### Rules for every new hook

- The candidate is data the plugin may change, never an object from a repository.
- The call site validates the result and passes it through the same checks as client input; a hook
  never gets more power than the user who triggered the action.
- A hook that can refuse is added only after the rejection mapping above exists.
- Hooks run in the request path with a 5 s budget each: keep candidates small and never call a hook
  inside a database transaction or while holding a lock (the artifact write is the documented
  exception: it runs under the per-owner write lock, so its hook must stay cheap).
- Plugins reach data through services (`src/services/**`), never repositories, so a plugin's own
  writes pass the same hooks and events as a core write.

---

## Part 3 — Deferred performance work after 1.3.2

These items came out of a measured 50,000-row cold run on a Ryzen 7 7800X3D, Bun 1.4.4, using
`bun run benchmark http --rows 50000 --concurrency 10 --duration 3000 --warmup 1000 --no-cache --no-dedup`.
The important number is the **no-dedup** one: with request coalescing enabled, ten identical requests
share one computation and the result flatters every endpoint. Treat cache hits and deduped runs as a
separate, warm steady-state measurement; never mix them with the numbers below.

Current cold/no-dedup ranking (50k, c=10, p95 in parentheses):

| endpoint                       | req/s |    p95 |                  in-process cost |
| ------------------------------ | ----: | -----: | -------------------------------: |
| admin dashboard                |    37 | 319 ms |                          17.8 ms |
| discover                       |    47 | 248 ms | 8.4 ms service, 21.9 ms HTTP c=1 |
| similar                        |    70 | 154 ms |                          13.4 ms |
| FTS `search/global`            |    83 | 205 ms |                           4.6 ms |
| libraries list/detail          |   133 | 139 ms |                           7.4 ms |
| filtered year+genre            |   149 |  72 ms |                           6.3 ms |
| deep offset page               |   257 |  42 ms |                           3.5 ms |
| wrapped                        |   417 |  26 ms |                            ~2 ms |
| catalog browse                 |   570 |  20 ms |                          1.36 ms |
| collections (distinct posters) |   580 |  19 ms |                           1.9 ms |

The safe wins shipped after the baseline were: trait-union similar scoring, junction covering
indexes, `media_files_library_size_idx`, collection poster fast path with exact fallback, admin
dashboard covering indexes, and leaner Discover candidate/relation reads. The items below are the
remaining work; **do not start an item that changes a response, the SDK or a schema without approval
for the release that owns it.**

### 3.1 Materialised media counters for the admin dashboard and library stats

**Where:**
- `src/services/admin/dashboard/stats.service.ts` — `computeStats()` aggregates
  `adminStatsRepository.getMediaStats()`, `getMetadataStats()` and `getMarkerStats()`.
- `src/repositories/admin-stats.repository.ts` — the media aggregate is one
  `COUNT(*) / SUM(file_size) / COUNT(CASE …)` scan over `media_files`; metadata is a second scan.
- `src/repositories/libraries/stats.reader.ts` and `src/repositories/libraries/reads.reader.ts`
  (`findPage`) — the library list/detail aggregate is
  `COUNT(*) + SUM(file_size) GROUP BY library_id`.
- Current indexes: `media_files_admin_stats_idx`, `metadata_admin_stats_idx`,
  `media_files_library_size_idx`.

**Current cost:** admin stats **17.8 ms** in-process, **37 req/s** at c=10/no-dedup (p95 319 ms).
Library list **7.4 ms**, **133 req/s** (p95 139 ms). Both are full aggregates over 143k media files
and 50k metadata rows even with covering indexes; indexes only make the scan narrower.

**Proposed design:** add maintained summary tables, not another index.

```sql
-- one row per library
CREATE TABLE library_media_stats (
  library_id   TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  file_count   INTEGER NOT NULL,
  total_size   INTEGER NOT NULL,
  movie_count  INTEGER NOT NULL,
  episode_count INTEGER NOT NULL,
  quality_count INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- one row for the whole catalog
CREATE TABLE catalog_media_stats (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  file_count    INTEGER NOT NULL,
  total_size    INTEGER NOT NULL,
  movie_count   INTEGER NOT NULL,
  episode_count INTEGER NOT NULL,
  quality_count INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

Metadata counters can live in a third row/table (`catalog_metadata_stats`: total, movies, shows,
low-confidence, missing-translation) or in the same `catalog_media_stats` if the write paths are
kept together. Do not put them in a generic key/value settings table; the update needs one statement
and a typed row.

**Maintenance:** every write that changes a counted column must update the summary in the same
transaction. The complete production list today:
- `src/repositories/media-files/writes.writer.ts`
  - `createWithStreams()` — insert: `+1 file`, `+size`, `+movie/episode/quality` flags;
  - `deleteAndGetCleanup()` and `deleteByIds()` — delete: `-1`, `-size`, flag counts;
  - `deleteByLibraryAndPaths()` — delete by path, same decrement;
  - `deleteByLibraryAndPathsAndGetCleanup()` delegates to the above;
  - `reassign()` — moves a file between metadata/movie/episode rows; the file count and total size do
    not change, but movie/episode counts can;
  - `replaceTechnicalData()` — **`size` can change on a rescan**; add the delta to the total;
  - `setDefault()` does not change counted fields.
- `src/repositories/libraries/remove.writer.ts` — removes a whole library and its media files.
- `src/repositories/metadata/cleanup.writer.ts` — `deleteWithMediaFiles()` removes files for one title.
- `src/repositories/metadata-merge.repository.ts` — repoints media files between titles/libraries;
  the summary is per library, so recompute both affected libraries after a move.
- Any future writer that deletes by FK cascade (`movies`, `episodes`, `libraries`) must be audited;
  a file can disappear without going through media-files writes.

**Triggers or writers?** Two valid implementations:
1. SQLite triggers in a raw migration. The repository already has a raw SQL migration for FTS5
   virtual tables/triggers (`migrations/20260923212000_fts5_search/migration.sql`), so this is a
   precedent. Triggers catch every write, including future code and FK cascades, but are harder to
   test and review, and a bug is silent at the SQL layer.
2. Explicit updates in the writers above. Type-safe and testable, but one missing path drifts.
   Prefer this only if the team accepts a periodic reconciliation job (`database-maintenance`) to
   rebuild the summaries and log/notify on drift.

Whichever path is chosen, the update must be inside the same transaction as the media write. Never
update the summary from a detached fire-and-forget task: the write may commit and the summary not.

**Backfill:** a one-time rebuild at boot (or a migration step) that runs
`INSERT … SELECT library_id, COUNT(*), SUM(file_size), … FROM media_files GROUP BY library_id`
plus the global row. Make it idempotent and skip it when the tables already match; a boot rebuild is
acceptable only if it is bounded and logged. On a large library this is a full scan; measure it and
do not block the first request invisibly.

**Acceptance:**
- A test seeds distinct libraries, inserts files with different sizes, deletes one, changes one
  `size` through `replaceTechnicalData`, moves one file through `reassign`, deletes a library, and
  after every step asserts the summary equals a direct `GROUP BY` over `media_files` with literal
  expected values.
- Merge a movie and a TV show with media files in different libraries; both library rows and the
  global row match the live aggregate.
- Admin dashboard read is **<1 ms** at 50k rows; library list read is **<1 ms**.
- A write benchmark (10k inserts) measures the added cost; report before/after. A single extra
  `UPDATE` per write is preferable to a trigger if the trigger cannot be measured reliably.
- No response shape change; the API keeps its existing fields. `AdminStats` and `Library` SDK types
  stay unchanged.

**Risks:** double counting in transactions, missing a cascade path, stale rows after a failed
transaction, and a boot backfill that blocks startup. This is the highest-risk performance item;
do it as one isolated change with a reconciliation query in the test suite.

### 3.2 Keyset pagination for the default metadata list (SDK/API change)

**Where:** `src/repositories/metadata/queries.reader.ts` `findPage()`, the `cursorMode` branch;
`src/api/routes/v1/metadata.routes.ts` `GET /metadata`; SDK `CursorPaginationQuery`,
`CursorPaginatedResponse`, `MetadataSorting` and the website client's list loader.
Today `cursorMode` only applies when `sortBy === "createdAt"` (or no sort) and sort order is
descending. The default browse sorts by title and uses `page`/`offset`.

**Current cost:** deep page (`page = rows / 24 / 2`, offset 25k at 50k) is **3.5 ms** in-process,
**257 req/s** at c=10/no-dedup (p95 42 ms). `metadata_sort_title_nocase_id_idx` serves the order,
but SQLite still walks 25,000 index entries. More rows make it linearly worse.

**Proposed change:** add a keyset cursor for the title sort:
- cursor payload `(sortTitle, id)`; use the same `encodeCursor`/`decodeCursor` helpers or add a
  typed variant next to `keysetWhere`.
- `WHERE (COALESCE(sort_title, title) COLLATE NOCASE, id) > (?, ?)` for ascending, the reverse for
  descending. SQLite supports row-value comparisons; verify the plan uses
  `metadata_sort_title_nocase_id_idx`.
- Response adds `nextCursor` and takes `cursor`; keep `page` working for compatibility, but document
  that mixing `page` and `cursor` is refused (validation error).
- `total` remains the same count; it is the expensive part on a cold count (5–6 ms filtered). A
  cursor page still needs a total for the current UI, so the count cache remains relevant. Do not
  remove `total` in the same change.
- SDK: add the cursor/response fields; bump `@reelvault/sdk`, then the website client and this repo.

**Acceptance:**
- A test with at least 50 titles sharing a title prefix fetches page 1 and the cursor page; no row
  repeats and no row is skipped, with literal expected ids.
- Deep cursor on 50k is **<1 ms** in-process; the `EXPLAIN QUERY PLAN` is a range search on the
  sort-title/id index, not a scan.
- `page` and `cursor` together return a validation error with a stable code.
- No existing response field is removed; only optional fields are added.

**Risks:** cursor semantics on `COALESCE(sort_title,title)` and non-unique titles; tie-breaking
must include `id`; clients that only send `page` must keep working. This is an API/SDK change, so it
waits for the release that can bump the SDK.

### 3.3 FTS ranking is candidate-bound; changing it is a product decision

**Where:** `src/repositories/metadata-search.reader.ts` `searchGlobal()`; the FTS table
`metadata_fts` and its triggers in `migrations/20260923212000_fts5_search/migration.sql`.

**Current cost:** **4.6 ms** in-process, **83 req/s** at c=10/no-dedup (p95 205 ms). Measured
variants on 50k:
- direct join + `ORDER BY rank`: 4.62 ms;
- FTS-only ids + second metadata lookup: 4.27 ms;
- subquery + join: 4.06 ms;
- explicit `bm25()`: 9.16 ms (worse).
  `star*` matches **10,000** seeded titles (`Star Odyssey N`), so the cost is ranking 10k matches, not
  a missing index. A subquery would save ~0.5 ms and add a statement; not worth it alone.

**Do not** add a speculative trigram/prefix rewrite. If search latency becomes a product problem,
choose a semantics change explicitly:
1. cap the ranked candidate set by a cheap filter (e.g. popularity/recency) before ranking — changes
   which titles can appear;
2. require a longer prefix or an exact token before the ranking path;
3. change the UI to search only titles when the term is a common prefix.
   Each option needs a product decision, new expected results and a benchmark with the same 10k-match
   fixture. The current implementation stays until then.

**Acceptance for any future change:** a test with at least 10,000 titles sharing the prefix pins the
returned top-N ids as literals; the benchmark shows a material gain; the result set is documented as
a deliberate change.

### 3.4 Materialised collection poster previews for shared images

**Where:** `src/repositories/collections/previews.reader.ts`. The current fast path reads the first
16 poster rows per collection and deduplicates in memory; if that window is full and has fewer than
four distinct images, it falls back to the exact distinct-image window
(`queryRankedPosters`). This is exact but the fallback scans every member of the collection.

**Current cost:** distinct posters **1.9 ms** in-process; a collection that shares one image across
its members still pays **~21 ms** cold (the fallback). The benchmark seed now uses 128 poster
variants so the common path is measured; the shared-image fallback remains for correctness.

**Proposed change (only if shared posters are common in real libraries):** a maintained
`collection_poster_previews` table:

```sql
CREATE TABLE collection_poster_previews (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  rank          INTEGER NOT NULL,
  image_id      TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (collection_id, rank)
);
```

One row per displayed poster (max four per collection), with `rank` 0..3. Rebuild the affected
collection when:
- metadata joins/leaves a collection (`collections.repository.ts` `process()` and the metadata
  collection writers);
- a poster link is added/removed/changed (`metadataImages` writes, image deletion, image update);
- a collection is deleted (cascade).
  The ranks must keep the current order: `MIN(metadata_collections.sort_order)`, then `image_id`, and
  deduplicate by image id. A rebuild for one collection is a small query; do not rebuild the whole
  table on every write.

**Backfill:** a one-time per-collection rebuild after the migration; for large catalogs, batch it and
log progress.

**Acceptance:**
- Existing preview tests pass unchanged (four distinct posters in shelf order; one shared poster
  deduplicates).
- A 20-title collection sharing one poster returns **<2 ms** cold and exactly one poster.
- A randomized sequence of add/remove/reorder/image changes matches the current full query.
- The write path's extra cost is measured.

**Risks:** four separate write paths can invalidate the preview; a missed invalidation shows a stale
poster. This is a schema/write-path change, not a query-only patch.

### 3.5 Discover has a measurable gap between service time and HTTP time

**Where:** `src/services/users/discover.service.ts` (`buildDiscoverView`, `getRecommendations`),
`src/services/users/discover-recommendations.service.ts`, `src/repositories/discover.repository.ts`,
`src/api/routes/v1/discover.routes.ts`.

**Current cost:** with a real profile (300 watched rows, 40 watchlist, 6 ratings) the service build
is ~**8.4 ms** in-process. The HTTP endpoint at **c=1** is **21.9 ms p50**, and the CPU profile shows
**61.8%** of samples in native SQLite `values`. At c=10/no-dedup it is **47 req/s** (p95 248 ms).
Measured service subparts after the recent cleanup:
- `findRecommendationCandidates` ~1.0–1.4 ms (four queries; catalog 500, watched 300, ratings,
  watchlist);
- `findRecentlyAddedByTypes` ~0.7–1.7 ms;
- combined genre/keyword/cast relations ~1.4 ms for 837 ids;
- `findRecentlyWatchedByOthers` ~0.5 ms; playback signals ~0.1 ms; hydration ~0.7 ms; scoring JS
  ~1 ms.
  The sum does not explain the 13 ms gap between service and HTTP.

**Investigation plan (do this before changing code):**
1. In the spawned benchmark server (not an in-process script), enable per-statement timing for one
   discover request. The existing `DatabaseQueryLogger` logs only statements ≥100 ms in production;
   add a benchmark-only threshold (or an env-gated low threshold) and flush the server log before the
   process exits. Keep the log in the benchmark result directory.
2. Compare the statement list with the in-process list. Look for:
   - `buildTrending()` fetching/relations beyond the ids it needs;
   - recommendation hydration fetching all 50 scored titles while the response only returns 10;
   - a second relation load for the final recommendation page;
   - auth/profile/preferences queries that the service script does not run.
3. Run the same request with background workers and watchers paused (or with a longer poll interval)
   and compare. If the gap drops, it is worker/DB contention, not the discover query.
4. Only then choose the fix: hydrate only the final 10 recommendations, compute relation scores in
   SQL instead of loading 837×relations, or project fewer fields. Preserve the exact recommendation
   order and the existing response shape.

**Acceptance:** a statement-by-statement trace for one discover request is checked in as a benchmark
artifact or test note; c=1 p50 is **<12 ms**; c=10/no-dedup is **>80 req/s** at 50k; the existing
recommendation/diversity tests stay green. No SDK change.

**Risks:** recommendation ordering is easy to change accidentally; keep the existing
`discover.service.test.ts` and `discover-recommendations.test.ts` literal fixtures and add a
before/after id list.

### 3.6 Similar scoring precomputation (bigger change, optional)

**Where:** `src/repositories/metadata-recommendations.reader.ts` `rankSimilarIds()`/`buildTraitUnion`.
The query now aggregates traits once and the junction indexes carry `metadata_id`; the remaining
cost is grouping ~13k candidates and sorting by the dynamic score.

**Current cost:** ~**13.4 ms** in-process, **70 req/s** at c=10/no-dedup (p95 154 ms). Covering
indexes took the raw query from ~19.1 to ~16.5 ms; a further large win needs a different model.

**Options:**
1. Precompute a per-title trait vector or top-N similar ids on metadata save/refresh. Invalidate on
   any trait change (genres, keywords, cast, crew, collections, type) and on title deletion. This
   needs a table plus write-path maintenance, similar in risk to 3.1/3.4.
2. Keep the query but precompute only the relation score counters per source title (genre/cast/
   keyword maps) so the candidate pass reads counters instead of joining; still invalidated on
   metadata changes.
3. Restrict scoring to a cheap top-N prefilter (e.g. popularity) before the exact score — changes
   results and needs a product decision.

**Acceptance:** a literal fixture with two collections, two directors, multiple cast roles and
keywords returns the same order as today; cold in-process <5 ms; invalidation tests cover every trait
change. No SDK change.

### 3.7 Split request and background SQLite time

**Where:** `src/workers/core/worker-polling.service.ts`, worker scheduler/pool, library watcher, and
the resource allocator. The CPU profile attributes most cold time to native SQLite `values`, but the
profiler does not say whether the statement came from a request or a poller.

**Current evidence:** the no-dedup run lowers many endpoints far more than their in-process cost
suggests (e.g. libraries 651 → 133 req/s, similar 98 → 70, admin dashboard 270 → 37). Some of that is
the expected loss of request coalescing, but some may be background work on the same SQLite
connection. The discover c=1 profile has 61.8% native SQLite while the service build is 8.4 ms.

**Investigation:**
- Add an async-context label (request vs worker) around DB calls or log the current async scope in
  the query logger.
- Run the same benchmark with workers/watchers disabled or with a longer polling interval; compare
  per-endpoint p50/p95.
- If background work is material, batch/coalesce poller reads, raise the interval on small hosts, or
  move non-urgent reads off the request connection. Do not simply lengthen the interval without
  checking worker latency and stale-job behaviour.

**Acceptance:** a measured request-vs-background SQLite split; if background is <10% of request
time, close this item with the evidence; if it is larger, name the query and the change.

### 3.8 Investigated, no action

Keep these notes so another agent does not repeat the work:
- **Admin breadth** (`GET /v1/admin/*` 9 routes): per-route warm p50 0.2–1.3 ms. The 459 ms p95 at
  c=10/no-dedup is queueing across nine routes, not one slow route. No route-specific fix.
- **Filtered `year+genre` count**: 5.3 ms with the covering genre index; the page still uses a temp
  B-tree (6.7 ms raw) because the order is title while the filter is a release range. No safe
  composite index removes the sort; a materialised count or keyset (3.2) is the real fix.
- **Deep offset** is covered by 3.2; do not add another offset index.
- **Wrapped/insights**: 1.3–2.0 ms service time; the HTTP p95 is queueing. No query change.
- **FTS**: see 3.3; ranking 10k prefix matches is the cost.
- **Collections shared poster fallback**: see 3.4; the fast path is exact for distinct posters.
- **Admin dashboard and library stats indexes**: already added; more indexes only move the same
  full scan. The summary table (3.1) is the next step.

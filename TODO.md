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

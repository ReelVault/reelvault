# v1.0.0

### Features

- **API keys for integrations** — create scoped keys (`read_only` / `full`) in the admin panel, authenticate via `x-api-key`, expiration and last-used tracking, full audit trail. OpenAPI stays public.
- **Multi-episode files** — a file named `Show S01E01-E03.mkv` now imports as **one library entry per episode**, so watch progress, resume and playback work per episode. Range names (`S01E01-E03`, `1x01-03`, `01-03`) are recognized; copy suffixes like `_001` are no longer mistaken for episodes; scans self-heal range files that were imported with missing episodes.
- **Per-library metadata language** — optionally fetch titles, overviews, season and episode names in a chosen language for a single library, overriding the provider's own language.
- **Notification channels (plugin capability)** — plugins can now deliver notifications (webhooks, messengers) via `host.notificationChannels`; enriched `notification.created` events with title/message/link. Ships with a reference `notify-webhook` plugin.
- **Per-library provider priorities** — override the global metadata-provider order for a single library.
- **Database restore from the admin panel** — restore a backup with confirmation; the server shuts down and restarts into the restored snapshot.
- **New server settings** — enforce 2FA on login, watched-history retention, backup retention count, analytics window, custom scanner video extensions and ignore patterns, session lifetime, login rate-limit tuning, global rate-limit tuning.
- **Scheduled database backups** — weekly backup worker alongside the existing manual backups.
- **Plugin server-version floors** — catalog entries and `plugin.json` may declare `minServerVersion`; older servers refuse the install with a clear `plugin.server_too_old` error instead of breaking at runtime.

### Fixes

- Next-episode suggestion could return the episode currently being watched (and broke "play next" in both web and mobile).
- Renaming a profile onto an existing name returned a raw 500 — now a proper 409 with a translated message.
- Scene `sample.*` files bundled next to movies were imported as a bogus second version of the film; they are now skipped like dot-files.
- Correct profile auth status codes (PIN modal), worker category coverage, and admin error masking.

### Performance

- Library listing: cold path **472 ms → 47 ms** (in-memory path-stats matching replaces correlated SQL).
- Admin resources payload **525 KB → 76 KB** with bounded history; log endpoints serve incrementally parsed tails (search **9 ms → 0.6 ms**).
- New `created_at` indexes for media files and worker jobs; watched-history analytics and insights use aggregate-then-join plans (~2× faster at 100k rows); resource metrics retention enforced (92k → 3.4k rows).
- Static file serving **~3.4× faster** (Bun.file with Range support), HLS segments served immutable, nginx sendfile/http2 tuning, adaptive resource limits.

### Internal

- Major service-layer refactor (cycle breaking, database layer decoupled from server config, websocket protocol extracted), dead-code rules re-enabled, pre-release migrations squashed into a single `release_1_1_schema`, ships with `@reelvault/sdk` 1.1.1.

# v1.1.0

> [!WARNING]
> **Updating from v1.0.0 or v1.1.0 requires a manual step.** Those releases shipped with a bug that prevented the built-in updater from installing anything (archive installs were misdetected as `"dev"`). The in-panel updater works **from this version onward** — to reach v1.1.1, run the v1.1.1 installer over your existing installation (it preserves `data/`, `settings.env` and `web/`).

### 🐛 Fixes

- **Panel-driven updates were refused on archive installs** — the install root was computed from the wrong module directory level, so environment detection reported `"dev"` instead of `"archive"` and every install failed with `update.install_unsupported_install_type` (v1.0.0 and v1.1.0).
- **Update extraction failed on server releases** — archives ship `node_modules/.bin` as relative symlinks, which the tar extractor rejected as unsupported. Symlinks are now validated (relative targets must stay inside the extraction root) and created after all regular entries have landed; absolute, target-less and out-of-tree links remain rejected.
- **Server could not boot after an update swap** — permission bits were not restored from the tar headers, so `start.sh` and the bundled `bun` binary lost their executable bit.
- **`start.sh` failed on a bare `settings.env`** — `$APP_BUN_FLAGS` was expanded without a default under `set -u`; it now defaults to empty.

# v1.2.0

### Features

- **Watchlist hydration** — `GET /me/watchlist?hydrate=true` can now embed the full metadata card for each item, replacing the previous list → metadata request waterfall with a single request.
- **Batch playback suggestions** — `GET /me/playback-suggestions?metadataIds=` returns smart-play suggestions and watchlist state for up to 50 metadata IDs in one request, improving card grids and collection drawers.
- **Admin dashboard composite endpoint** — added `GET /admin/dashboard-view`, combining dashboard stats, libraries, worker operations, audit feed, error logs and update status into a single admin-only request. The response uses the same short-lived body caching strategy as `/admin/dashboard`.
- **Stable remote-access check codes** — remote-access checks now return structured `{ id, ok, code, params }` results instead of server-generated title/detail strings, allowing the web client to handle translations consistently.
- **Audit-log retention** — added `system.database.auditRetentionDays` (default: `180`; `0` = keep forever). A daily indexed cleanup now removes expired entries from `admin_audit_logs`.
- **Worker progress over WebSocket** — worker progress is now broadcast through throttled `worker:progress` WebSocket events, allowing clients to receive live progress without polling operations.
- **`LOG_LEVEL` control** — the minimum log level is now configurable (`trace`…`fatal`, default `info`); the debug log file is only created when `debug`/`trace` is selected.

### Fixes

- **Multi-episode files hit a stray unique index** — replaced the unconditional `media_files_path_unique` index caused by migration drift with the partial `media_files_path_unlinked_unique` index, unblocking range-based media files. The legacy-upgrade test now verifies the index predicate.
- **Over-long episode ranges were rescanned indefinitely** — the scanner calculated the full episode range while the processor capped it at 12 episodes. A file such as `S01E01-E99` could therefore be ingested successfully but re-added to `newFilePaths` on every scan. Scanner and processor now share `episodeRangeSpan` / `episodeRangeTargets`.
- **Playback progress without a profile returned 404** — all eight affected call sites now use the shared profile guard and consistently return `401 auth.profile_required`.
- **Playlist generation timeouts returned generic 500 errors** — `waitForFile` now rejects with a typed domain error, which the waiter maps to `playlist_generation_timeout`.
- **Admin-killed sessions could be recreated** — session creation and access checks now share the same admin-session matching helper, preventing sessions such as `admin-stop` from being recreated after termination.
- **Playback diagnostics lost tone-mapping state** — restored `tonemapped` and `toneMapMethod` to the session projection. Fixtures use non-default values so missing fields are now caught by tests.
- **Media audit used a different match-score threshold** — removed the hardcoded `0.65` threshold and aligned audit behaviour with `metadata.minMatchScore`, matching admin statistics and browse filters.
- **Reoptimized images could serve stale data** — in-place image rewrites now invalidate the source-version cache immediately instead of potentially serving the previous `(size, mtime)` entry for up to five minutes.
- **`ffprobe` abort listeners accumulated on reused signals** — listeners are now removed in `finally`, with settle, abort and pre-aborted paths covered by tests.
- **Failed plugin enqueues left orphaned jobs** — rollback previously passed an operation ID to a worker-ID filter and cancelled nothing. `enqueueWithOperation` now removes pending jobs by operation ID before deleting the operation.
- **Log-tail cache could remain stale after rotation or truncation** — cache entries are now invalidated before rebuilding the window, preventing stale data from being served for the remainder of the TTL.
- **Worker scheduler rewrote null deadlines every minute** — trigger-less workers no longer receive a no-op `UPDATE` that only changes `updated_at`. Deadlines are now written only when they are armed or cleared.
- **Private responses leaked between machine API keys** — the response cache and request-dedup identity omitted `x-api-key`, so two integration keys of different accounts could receive each other's body (for example `/v1/notifications`). Both keys now include the API key, and dedup keeps GET and HEAD apart as well.
- **Access-controlled artifacts were publicly cacheable** — playback artifacts served behind the stream-access policy sent `Cache-Control: public, max-age=86400`, letting shared proxies replay them after an access change; they are now `private`.
- **Notification updates ignored `read:false`** — both `PATCH /v1/notifications` and `PATCH /v1/notifications/:id` always marked notifications read. They now honour the flag, and re-marking an already-read notification succeeds instead of returning 403.
- **Quick-connect paired PIN-protected profiles locked** — the session cookies carried an empty PIN fingerprint, so a paired device could never activate a PIN-protected profile and silently fell back to "no active profile". Quick-connect now copies the authorizing profile's stored PIN fingerprint into the issued unlock cookie (both the device-pairing and voucher flows).
- **API keys bypassed the profile PIN lock** — a machine key could resolve a PIN-protected profile via `x-profile-id`/`current_profile_id` without an unlock token. All credential types now pass through the same PIN check, so a locked profile stays locked for API keys too.
- **Invalid server settings silently reset configured values** — a malformed value (for example `"stream.maxSessions": "eight"`) was replaced with the definition default and answered `200`, overwriting the configured value. Updates now fail with `admin.settings.invalid_value`; stored/legacy values still decode leniently at boot.
- **Second in-panel update always failed** — the swap moved the live files into a non-empty `.previous/` directory, which POSIX `rename` rejects with `ENOTEMPTY`; only the first update of each component could succeed. The latest update now replaces the rollback snapshot (matching the Windows swap script).
- **Rematching metadata deleted the files it had just repointed** — duplicate conflicts were dissolved by repointing `media_files.metadata_id` and deleting the duplicate row, but the files' `movie_id`/`episode_id` still referenced the duplicate's `movies`/`episodes` rows, which the FK cascade removed together with the files (and their progress, history and markers). Conflicts now resolve through the merge path, which repoints the movie/episode references first and creates the target's movie row when it does not exist yet.
- **Resumed operations could be deleted with all their jobs** — the daily retention sweep selected expired operations without checking their status, and resuming an operation kept its terminal retention deadline. An operation resumed after the retention window was deleted (with its jobs) while still running. The sweep now only considers terminal operations, and resuming clears the deadline.
- **Cancelling running jobs could corrupt operation counters** — the bulk cancel counted running jobs before the update and applied those counts outside a transaction, so a job that finished mid-cancel was counted as cancelled as well (`completed + cancelled > total`). The row transition and its counter update now share one transaction.
- **Cancelled streaming sessions could come back to life** — a late ffmpeg attach unconditionally reset the operation to `running`, and a natural EOF on a cancelled stream flipped it to `completed`. Both lifecycle events now respect a cancellation, so a killed session stays terminal.
- **Deduplicated enqueues left phantom operations behind** — when two triggers (double-clicked scan, watcher + manual scan, two "refresh all" requests, repeated plugin job) raced, the loser's operation stayed `pending` with zero jobs forever, and the metadata refresh-all path could even return an operation that owned nothing. Orphaned operations are now removed, and a fully deduplicated refresh answers `409 admin.metadata.refresh_in_progress`.
- **A failed scheduled enqueue silently skipped the whole period** — the scheduler logged a warning and advanced the deadline anyway, so a transient failure made a daily/weekly job (backup, cleanup, update check) miss its run until the next period. The deadline now stays due and the next tick retries.
- **Silent (video-only) files were unplayable and undownloadable** — every stream and download mapped audio as a hard `0:a:0`, so ffmpeg aborted with "matches no streams" on sources without an audio track. The audio maps are now optional (`0:a:0?`).
- **A remembered audio track with an unsupported codec broke playback** — the playback decision was computed from the smart-selected track's codec while the stream map used the remembered track's index, so an E-AC-3/TrueHD resume could be copied into a client that only decodes AAC. The decision now describes the track that is actually mapped.
- **Editing a subtitle kept serving the old cues** — the extracted WebVTT cache was only removed on delete, so changing the stream index or source in `PATCH /v1/subtitles/:id` served the previous track indefinitely (and a replaced external file leaked on disk). Updates now drop the cached VTT — plus the previous external file when the source changed — and subtitle writes invalidate the cached list/detail responses.
- **Deleting media could permanently exhaust a plugin's artifact quota** — the cached per-plugin byte total survived files removed by scanner/media cleanup, so a plugin could hit `plugin.artifact.quota_exceeded` while well under quota. External cleanup paths now invalidate the cached totals, and concurrent writes within one plugin are serialised so the check-then-write quota window cannot be raced.
- **A partially unmounted library silently deleted records** — the removal guard only vetoed removals covering at least half of the library, so an unmounted share holding a smaller slice had all of its rows purged (cascading watched history, progress and markers). A library root that is no longer reachable now vetoes the entire removal phase.
- **Notification channels registered from `setup()` could never load** — the plugin id was bound only after setup, so `host.notificationChannels.register()` threw and the whole plugin failed to load. The id is now bound before setup, and a duplicate channel id fails with a clear error instead of silently overwriting the previous registration.
- **A plugin reload could cancel its own fresh jobs** — unregistering the old worker cancelled its pending jobs from a detached task that could land after the reloaded plugin had already enqueued new ones. Worker unregistration now awaits the cancellation before the reload continues.
- **Purging worker history could delete an active operation's early jobs** — the manual/weekly purge removed operation-linked terminal jobs that still belong to a running operation (its own purge owns them), leaving operation counters without matching rows. The job purge now skips operation-grouped rows, matching the retention trim.
- **Retried jobs showed stale progress** — a retried row kept the failed attempt's progress percent, start time and result while waiting for its backoff window. Retries now reset that state.
- **Paginated admin lists could repeat or skip rows** — operations and jobs were ordered only by second-resolution `created_at`, so same-second rows could shuffle between pages. Both lists now tiebreak on the row id, and the `LIMIT`-based sweeps (downloads retention, missing-trickplay scan, resume source) pick a deterministic order too.
- **Merging two shows could bind files to the wrong episode** — the merge matched episodes by number alone, ignoring `episodeType`, so a special E1 could absorb a regular E1's media files (the unique key is season + type + number). Episode matching now includes the type.
- **Search terms containing `%` or `_` matched extra rows** — the global title search, the admin user list and the worker-job search bypassed the shared LIKE escaping, so wildcard characters acted as wildcards instead of literal text. Every search path now escapes consistently.
- **Interrupted downloads could block a profile forever** — a crash or restart left rows in `pending`/`processing` with no live ffmpeg, and a download whose media file had disappeared stayed queued indefinitely, pinning the profile's single active-download slot until it was manually cancelled. Startup now reconciles stale rows (re-enqueueing them, or failing those whose source is gone), a missing source fails immediately, and the worker marks the row failed once its retry budget is exhausted.
- **Replacing a profile avatar leaked the previous image forever** — unlike every other image owner, the avatar swap neither collected the old image nor counted profiles in the "still referenced?" probe, so each avatar change left an orphan row and file behind. The previous avatar is now deleted when unreferenced and the probe checks `profiles.avatar_url`.
- **The on-disk optimized-image cache never worked on Windows** — its keys embedded the source stamp `size:mtime`, and `:` is not a legal NTFS filename character, so every request re-ran sharp. The stamp is now sanitized.
- **`If-None-Match: *` was treated as a literal** — `*` and some multi-value validators received a full body instead of a 304, and the SPA entry's 304 dropped its `ETag`/`Cache-Control`/`Content-Type` headers. Conditional requests now use the shared RFC-style matcher and 304s repeat the validating headers.
- **Compression ignored explicit `q=0` refusals** — `Accept-Encoding: br;q=0, gzip` still selected brotli (and a `x-gzip` token matched gzip). Encoding negotiation now parses quality values and matches exact tokens.
- **Changing a library's metadata language kept the old language for 30 seconds** — the per-library override cache was not invalidated by the edit; the library update path now drops the entry.
- **A refresh could silently clear the missing-translation flag** — providers that omit `hasMissingTranslation` reset it to `false`, so the admin translation filter lost titles whose provider does not report the field. An omitted flag now leaves the existing state untouched.
- **A subtitle deleted mid-scan could be imported as a dangling row** — the sidecar directory listing is cached for a few seconds; candidates are now existence-checked before import.
- **Streaming ffmpeg logs could not be correlated with the panel operation** — the operation log was filed under the playback session id instead of the session's worker `operationId`, so neither id led to the other. The log now carries the operation id (falling back to the session id only when there is none).
- **A paused client scrubbing could be reaped mid-seek** — an unbuffered seek restarts ffmpeg but never refreshed the session's activity clock, unlike the buffered path. Seeks now keep the session alive.
- **A stuck ffmpeg could wedge session release and shutdown** — after SIGKILL the code waited for `process.exited` without a bound, so an uninterruptible process (for example a stalled network mount) blocked teardown forever. The wait is now bounded.
- **An aborted keyframe probe disabled keyframe seeking for that bucket** — a cancelled probe was cached as "no keyframe" for the whole TTL. Aborted probes are no longer cached.
- **Trickplay previews could emit an invalid `00:00:60.000` timestamp** — the formatter rounded seconds without carrying into minutes, which strict WebVTT parsers reject. Timestamps are now built from whole milliseconds.
- **`/me/playback-suggestions` did not enforce its documented 50-id cap** — the batch now trims the id list before the lookup.
- **Read-then-write transactions could fail spuriously under load** — job claiming, metadata merge/rematch and image replacement started with a deferred `BEGIN`, so a write committed by the main connection inside the read window made SQLite fail the upgrade with `SQLITE_BUSY_SNAPSHOT`. These transactions now take the write lock up front (`BEGIN IMMEDIATE`).
- **Provider links could be silently dropped** — the provider junctions carried a unique index on `provider_id`, so two local rows that legitimately share one provider row (duplicates, localized renames) could never both link to it: the second insert was discarded without an error. The index is removed by a generated migration; the composite primary key still prevents duplicate pairs.
- **Trickplay admin generation returned a misleading id** — the bulk route reported only a count and the single-file route could return a job id in place of an `operationId`, so progress/cancellation could not be tracked. Both routes now enqueue under a real worker operation and return it.
- **Sidecar-first scans ignored the app's own `.reelvault.nfo` snapshots** — the NFO locator only knew the Kodi/Jellyfin file names, so libraries using the default `reelvault` sidecar flavor fell back to filename parsing whenever providers were unavailable. The locator now reads `.reelvault.nfo` movie/series/season/episode snapshots as a fallback (a standard `.nfo` still wins), and the Jellyfin reader no longer claims those files.
- **Prerelease versions compared as their release** — `2.0.0-rc.1` ranked equal to `2.0.0` (and newer than `1.9.0`), so the updater could offer a release candidate as a stable upgrade, and `1.2.4-beta` was treated as equal to `1.2.4`. Version comparison now follows semver prerelease precedence.
- **Slow realtime clients silently lost events** — `socket.send()` drops a message and returns `-1` when the buffer is full, but the value was ignored and the connection kept refreshing its activity clock. Drops are now detected (never counted as delivered, liveness not refreshed), and a connection that keeps dropping is closed so the client reconnects and resynchronizes.
- **The orphan-metadata purge could abort or miscount** — it re-fetched the same page whenever a delete silently skipped rows (no cursor), a media file attached mid-purge aborted the whole delete with an FK error, and the reported count included FTS trigger rows (`changes`). The purge now pages by id cursor, re-checks orphan status at delete time, and reports actual deletions.
- **Additional episodes of a range file could permanently miss their side effects** — when a crash happened after the extra rows were created, the retry skipped sidecars, trickplay, analysis and plugin events because the row already existed, and the main row had the same gap when no ingest-progress row had been written. Retries now run the missing post-create steps for the main row and every additional target.
- **Resuming a large operation lost jobs and could complete early** — resume re-enqueued only the first 5000 cancelled jobs, and because the operation total was reset while pages were inserted one by one, the first completed chunk could flip the operation to `completed` while later jobs were still being queued (it then left the active list and could no longer be cancelled). Resume now pre-sets the total to the full cancelled count, pages by id cursor until every job is re-enqueued, and the inserts skip counter increments.
- **Unwatchable library paths were only visible in the log** — a missing mount or an `fs.watch` failure silently disabled real-time scanning for that path (the reconcile tick retried forever with the same warning). The watcher now records the failure, exposes it via `getUnwatchablePaths()`, and notifies administrators once per failure episode; recovery clears it automatically.
- **Paths without a working watcher were never rescanned** — on NAS/NFS shares and hosts that exhaust inotify watches, real-time detection silently stops. Such paths are now rescanned automatically through the new `scanning.watcherFallbackIntervalMinutes` setting (default 30, `0` disables); the schedule pauses while server rescue is throttling and is cancelled on recovery or shutdown.
- **Upgrading a manually installed plugin could keep loading the old build** — a plugin whose directory name differs from its manifest id was updated into a second directory (`<id>`), and reload resolved through the stale id→directory index back to the old one (boot then raced two same-id builds). The installer now upgrades the existing directory in place (lockfile record first, then a manifest scan), removes stale duplicates for the same id, and the loader resolves ids through the lockfile record first; lockfile directory validation still rejects traversal but accepts a manual directory name.
- **The first transcode ran with half the adaptive thread budget** — the concurrency count already includes the process being started, but the divisor added one again (`budget / (n + 1)`), so a single transcode on an 8-thread budget used 4 threads. The adaptive budget is now split by exactly the number of concurrent transcodes: one transcode gets the full budget, two share it 50/50, and so on down to the floor of one thread.
- **Plugin installs and server updates buffered whole archives in memory** — extraction read the entire compressed archive and materialized the decompressed payload (roughly 3 GB transient for a 1 GB update), which could OOM small NAS hosts. Archives are now read, decompressed and written entry-by-entry as a stream — peak memory is one chunk plus the decompressor window. The tar reader is incremental (headers, GNU long names, padding and symlinks may cross chunk boundaries), still rejects unsafe paths, symlinks and unsupported entry types, and additionally preserves declared directories and rejects streams truncated mid-entry.
- **A failed plugin uninstall could wipe data while leaving the plugin installed** — storage, blobs and artifacts were removed before the package directory and lockfile; when the directory removal failed, the plugin still appeared installed but all of its data was gone. The package is now removed first and the data only after it succeeded.
- **Chunked notification and retention writes were not atomic** — a failure midway through a read-state batch left part of the notifications flipped, and the retention sweep stamped deadlines chunk by chunk. Both now run inside a single transaction, and "recently added" ordering gained an id tiebreaker so bulk imports with identical timestamps stay stable.

### Performance

The performance work focuses primarily on reducing unnecessary database work, eliminating request waterfalls, avoiding repeated filesystem operations, and moving repeated per-item work into batched operations.

#### Database & query efficiency

- **Selective projections** — `?fields=` queries now select only the requested root columns instead of issuing `SELECT *`.
- **Cheaper existence checks** — `ping` reads only the required indexed column, while `existsForVersion` uses `EXISTS ... LIMIT 1` instead of `COUNT(*)`.
- **Reduced index overhead** — removed redundant prefix indexes, eliminating unnecessary B-tree maintenance during writes.
- **Better covering indexes** — added indexes for scanner keyset pagination, downloads, `sortTitle`, worker listing/recovery and relevant `created_at` queries.
- **Provider-junction `provider_id` indexes** — restored the non-unique `provider_id` index on all eight provider junctions (it was dropped together with the buggy unique index). A lookup by `provider_id` now uses an index seek instead of a table scan: at 200k junction rows, 200 lookups took 956 ms before and 2 ms after (**~447×**); `query-plan` reports `full-scan` → `SEARCH ... USING INDEX`.
- **Incremental post-scan statistics refresh** — a finished library scan now runs `PRAGMA optimize` (re-analyses only the tables that changed) instead of a full `ANALYZE`, which scans every table and index synchronously and stalled the event loop on large catalogs. Seeded-DB measurement: 1.2 ms vs 6.2 ms at 5k rows and 2 ms vs 26 ms at 20k rows, with identical browse query plans. The daily cleanup worker keeps the full `ANALYZE`.
- **Paginated multi-path library stats** — the cold per-path prefix scan now keyset-paginates `media_files` (5 000-row pages, yielding every 4 pages) instead of materializing every file in one synchronous query. On a 300k-file multi-path library the transient heap dropped **55.3 MB → ~10 MB** and the longest event-loop block **141 ms → ~37–52 ms** (wall time roughly unchanged).
- **Streamed catalog-wide id scans** — the media-file audit and full-refresh workers now consume media-file ids/identities page by page (`scanAuditRowIds` / `scanAllIdentities`) and enqueue each page, instead of fetching the entire catalog into an array first. On a 300k-file catalog the scan's peak heap dropped **33.7 MB → 1.5 MB**.
- **RAM-scaled SQLite temp storage** — hosts with ≤2 GiB RAM now use `temp_store = FILE` and a 64 MiB `mmap_size` instead of always `MEMORY`/256 MiB, so a large `ORDER BY`/`GROUP BY` temp B-tree cannot OOM a small NAS/Pi. Measured on a 2M-row `GROUP BY`: RSS **+61 MB** with `MEMORY` vs **+3 MB** with `FILE`.
- **Cached worker stats** — `workerJobRepository.getStats()` (a whole-table GROUP BY hit by every worker-dashboard poll) now has a 5 s TTL cache: 100 calls over 100k jobs dropped 453 ms → ~0 ms. Counts may lag by up to the TTL.
- **Cached trickplay stats** — the admin trickplay page's whole-catalog `stats()` (LEFT JOIN + DISTINCT count) now has a 5 s TTL cache: 50 calls at 20k media files dropped 174 ms → ~0 ms.
- **Chunked realtime role lookup** — the admin-id lookup used by realtime fan-out chunks its `IN (...)` list, so a busy instance with many connections cannot exceed SQLite's per-statement variable limit.
- **Batched scheduler writes** — worker deadlines are now written using one multi-row upsert per scheduler pass instead of one UPSERT per worker.
- **Aggregated worker counters** — claim counters are aggregated per operation instead of issuing one `UPDATE` per claimed job.
- **Batched cleanup** — weekly retention, stale findings and plugin-artifact cleanup now use batched/chunked deletes instead of repeated per-row or per-worker statements.
- **Reduced session-reaper queries** — active-job checks are performed with one chunked query per sweep instead of one query per stale candidate.
- **Fewer relation queries** — next-episode resolution now uses one ordered query, while stream preferences are resolved through a single `LEFT JOIN` instead of separate file → metadata → preferences queries.
- **Cached aggregate counts** — frequently requested admin and collection counts now use short-lived caches.
- **Catalog refresh batching** — changed seasons and episodes can now be refreshed in a single batched operation instead of issuing one statement per affected record.
- **FTS maintenance** — reduced FTS5 segment growth after repeated title updates.

#### HTTP & middleware

- **Pathname reuse** — middleware route classifiers now reuse the pathname already extracted by the request pipeline instead of repeatedly parsing the URL.
- **Cached origin rules** — dynamic allowed origins and trusted origin patterns are cached per settings revision instead of being cloned and merged on every request. Profile PIN fingerprints and the HKDF-derived secret key are memoised, and non-public IPv4 range masks are precomputed at startup.
- **Reduced filesystem checks** — the security-header hook checks API/plugin prefixes before touching the web distribution, reducing unnecessary `stat` operations on health requests.
- **Batch APIs** — watchlist hydration and playback suggestions remove large client-side request waterfalls by resolving related data server-side.
- **Composite admin view** — the dashboard can fetch its complete view through one request instead of six independent requests.
- **Compression middleware guard order** — the cheap `Content-Encoding`/`Response` guards now run before the `Accept-Encoding` negotiation, so image, HLS and pre-serialized cached responses skip the parse entirely (micro-bench: 6.6 µs → 46 ns per 64 Response-path decisions).
- **Faster encoding/etag negotiation** — `negotiateEncoding` fast-paths a single plain token (1 172 → 564 ns per 9-header batch, ≈130 → 63 ns/header) and `matchesIfNoneMatch` fast-paths a single strong validator (257 → 163 ns per 6-header batch); multi-token, q-value and weak-validator headers keep the full parser.

#### Scanner & media processing

- **Provider-independent scan paths** — internal `scan`, `scanPath` and `getScanFindings` operations no longer load provider-priority overrides when they are not needed.
- **Removal-guard deduplication** — candidate paths are now checked once even when multiple database rows reference the same range file.
- **Concurrent cleanup events** — stale-media cleanup emits `media.file.unavailable` concurrently instead of awaiting one plugin handler per removed file.
- **Sidecar batch storage roots** — library roots are resolved once per sidecar batch instead of per media file and episode target.
- **Season/episode parsing memoization** — repeated `extractSeasonEpisode` calls on series paths are memoized, reducing execution time by roughly **28–45%**.
- **Streaming trickplay writes** — trickplay sprites are streamed directly from `BunFile` into artifact storage instead of creating a full-size in-memory buffer.
- **Safer temporary-file ownership** — temporary trickplay source cleanup is now handled by `writeFileWithRollback`.
- **Faster scanner matching** — optimized ignore-pattern matching and video-file detection to reduce repeated path and extension work.
- **Scan-root reuse in ignore matching** — the scan-relative root is normalized once per distinct root (memoized) and the ignore-pattern list is read once per root instead of once per file; `matchesIgnorePattern` over 500 paths × 3 patterns dropped 0.26 ms → 0.20 ms p50 (**−23%**).
- **Image-cache eviction without stat sweeps** — the optimized-image cache now tracks write order per directory, so recurring eviction deletes the oldest entries directly instead of `readdir`-ing and stat'ing the whole cache every 500 writes. On a 5 000-entry cache each steady sweep went from 5 500 `stat` calls + 1 `readdir` to **0**, with one reconcile per process on the first sweep; the cache stays bounded at the cap.

#### Plugins & artifacts

- **Faster plugin catalog loading** — repository loading is now performed concurrently instead of serially.
- **Cheaper SDK shim initialization** — warm plugin loads avoid repeated shim setup.
- **Faster runtime mirroring** — reduced filesystem overhead when mirroring large plugin trees.
- **Faster artifact quota calculation** — quota totals are aggregated without repeatedly walking individual files.
- **Cheaper event emission** — `emit` calls without subscribers now return significantly earlier.
- **Faster trickplay enqueueing** — generate-all enqueue overhead was substantially reduced without changing the actual generation pipeline.

#### Logging & caching

- **Logger sanitizer fast path** — benign keyword strings skip the expensive deep-clone path, making those sanitization operations roughly **2.2× faster**. Credential-bearing records still use the safe clone path.
- **Artwork cache invalidation** — in-place artwork changes now invalidate cached source versions immediately.
- **Log-tail cache invalidation** — rotation, truncation and size-cap changes invalidate the cached window before rebuilding it.
- **Cached audit parsing** — repeated audit status polls reuse the parsed/validated result instead of processing the same report on every request.
- **Trimmed production log volume** — the root logger defaults to `info` (was `debug`) and the debug log file is only registered when `debug`/`trace` is selected, so at default level `info` records are no longer written to a duplicated file. A 3 000-request browse workload wrote 1.93 MB of logs before and 0.90 MB after (**−53%**); HTTP throughput was unchanged within noise.

#### Worker & streaming updates

- **WebSocket progress delivery** — replaced client-side worker progress polling with one throttled WebSocket broadcast per progress tick. Database write frequency is unchanged.
- **Admin-scoped worker broadcasts** — `worker:progress` and `worker:job:completed` now go only to admin connections (the admin flag is resolved once at the WebSocket handshake) instead of every socket. With 100 connections of which 1 is admin, 20 000 frames drop from 2 000 000 to 20 000 socket sends (fan-out 92 ms → 43 ms).
- **Worker deadline writes** — trigger-less workers no longer generate periodic no-op updates.
- **Idle event-loop probe** — the loop-utilization monitor now samples every 1 s instead of 100 ms, cutting idle timer wakeups from 10/s to 1/s (measured idle CPU 3.40 ms → 2.18 ms per 2 s window).
- **Playlist cushion polling** — reduced the cost of the temporary-filesystem cushion check used during streaming.
- **Sparser start-cushion polling** — the 2 s playlist start-cushion wait now ticks every 100 ms instead of 20 ms, cutting the per-start playlist reads from ~100 to ~20 while still catching each new segment within 100 ms.
- **Leaner ffmpeg operation logs** — streaming/transcode ffmpeg runs `-loglevel warning -stats` instead of `info`, keeping errors and the progress line while dropping the per-run info block. The operation log for a 120s 1080p transcode dropped 6 374 → 3 972 bytes (**−38%**).

### Performance benchmarks

The table below focuses on representative end-to-end and database measurements rather than listing every individual micro-benchmark. Timed values are p50 unless stated otherwise; HTTP results are medians from three alternating runs.

| Area | Benchmark | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| HTTP | Health, c=50 — throughput | 24,896 req/s | 30,440 req/s | **+22%** |
| HTTP | Health, c=100 — throughput | 24,898 req/s | 32,341 req/s | **+30%** |
| HTTP | Health, c=100 — p50 latency | 3.74 ms | 2.92 ms | **-22%** |
| HTTP | Smart-play batch, 50 IDs — statements | 151 | 4 | **-97%** |
| HTTP | Smart-play, c=10 — throughput | 750 req/s | 2,250 req/s | **+200%** |
| HTTP | Smart-play, c=10 — p95 latency | 18.9 ms | 6.4 ms | **-66%** |
| DB | Metadata page of 24 — prepared statement | 0.08 ms | 0.05 ms | **-37%** |
| DB | `findTypeById` — prepared | 0.05 ms | 0.01 ms | **-80%** |
| DB | `findProgressUpdateData` — prepared | 0.05 ms | 0.01 ms | **-80%** |
| DB | Recently-added ranking, 20k titles | 19.2 ms | 8.6 ms | **-55%** |
| DB | Collections page — grouped count | 2.94 ms | 0.82 ms | **-72%** |
| DB | Catalog refresh — changed seasons + episodes | 48 stmts | 2 stmts | **-96%** |
| DB | Redundant prefix indexes | 10 B-trees/write | 0 | **-100%** |
| Workers | Trigger-less deadline rewrite | 1 UPDATE/min | 0 | **-100%** |
| Sidecars | Saving 20 episode files — episode/season lookups | ~44 stmts | 2 | **-95%** |
| Sidecars | Artwork export — unchanged source + target | 18.95 ms | 0.02 ms | **≈-100%** |
| Scanner | `isVideoFile`, 1,000 lookups | 0.65 ms | 0.10 ms | **-85%** |
| Scanner | `matchesIgnorePattern`, 500 paths × 3 patterns | 0.86 ms | 0.21 ms | **-76%** |
| Plugins | Catalog cold load, 3 repositories | 300.8 ms | 100.3 ms | **-67%** |
| Plugins | Runtime mirroring, 2,000 files / 50 dirs | 28.05 ms | 6.2 ms | **-78%** |
| Plugins | Artifact quota totals, 1,000 files | 10.10 ms | 1.13 ms | **-89%** |
| Plugins | Trickplay generate-all enqueue | 183 µs/file | 17 µs/file | **-91%** |
| Admin | Log-tail poll after 3 s idle, 20k-line JSONL | 7.94 ms | 0.31 ms | **-96%** |

### Additional measurements

A number of smaller changes were also benchmarked but are intentionally omitted from the main table to keep it focused:

- `findRootsById`: **-50%**
- `upsertProgress`: **-50%**
- `findNumberingModeById`: **-83%**
- `findMediaFileWithMetadata`: **-50%**
- Admin audit count with 10 s cache: **-73%**
- Worker operations count with 10 s cache: **-76%**
- Sessions count with 10 s cache: **-75%**
- Recently-added ranking, 5k titles: **-25%**
- Projected people list: **-50%**
- Projected episodes list: **-38%**
- FTS5 segment table after 1,000 title updates: **-23%**
- Media default flag swap: **-33%**
- Active-job snapshot: **-50%**
- Pending-job cancellation: **-50%**
- Playlist cushion polling: **-67%**
- Narrow library field reads: **-50%**
- `getScanFindings` without provider-priority overrides: **-33%**
- Episode NFO read: **-44%**
- Subtitle import for three sidecars: **-67–78%**
- Scanner `scanPaths` classification, 5,000 files: **-29%**
- Sidecar subtitle discovery for 24 episodes: **-52%**
- SDK shim initialization: **≈-100%**
- Plugin event emission without subscribers: **-85%**
- Local artwork staging, 20 MB: **-39%**
- Audit report parsing on repeated status polls: **≈-100%**
- Profile PIN fingerprint memoization: **-81%**
- HKDF secret-key derivation memoization: **-99.4%**
- Trusted-origin pattern cache with dynamic origins: **≈-100%**
- Trickplay end-to-end generation: **≈0%**, confirming that enqueueing improvements did not artificially improve the actual generation workload.
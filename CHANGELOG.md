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

## Features

- **Watchlist hydration** — `GET /me/watchlist?hydrate=true` now returns full metadata cards in one request instead of a list → metadata request waterfall.
- **Batch playback suggestions** — `GET /me/playback-suggestions?metadataIds=` handles up to 50 metadata IDs in one request.
- **Admin dashboard view** — added `GET /admin/dashboard-view`, combining dashboard stats, libraries, worker operations, audit feed, error logs and update status.
- **Stable remote-access check codes** — checks now return structured `{ id, ok, code, params }` results so the client can handle translations consistently.
- **Audit-log retention** — added `system.database.auditRetentionDays` (default `180`; `0` = unlimited) with daily indexed cleanup.
- **Worker progress over WebSocket** — live progress is now delivered through throttled `worker:progress` events instead of polling.
- **Configurable log level** — `LOG_LEVEL` now supports `trace`–`fatal` (default `info`); the debug log file is created only for `debug`/`trace`.

## Fixes

### Database & data integrity

- **Multi-episode files** — replaced the incorrect unconditional unique index with the partial `media_files_path_unlinked_unique` index, restoring range-based media files.
- **Over-long episode ranges** — scanner and processor now share the same episode-range limits, preventing files such as `S01E01-E99` from being re-added on every scan.
- **Profile-less playback progress** — affected endpoints now consistently return `401 auth.profile_required` instead of `404`.
- **Playlist generation timeouts** — typed `playlist_generation_timeout` errors now replace generic `500` responses.
- **Admin-killed sessions** — terminated admin sessions can no longer be recreated.
- **Playback diagnostics** — restored `tonemapped` and `toneMapMethod` to the session projection.
- **Media-audit match score** — audit now uses `metadata.minMatchScore` instead of a hardcoded `0.65`.
- **Resumed operations** — retention now applies only to terminal operations, and resuming an operation clears its retention deadline.
- **Job cancellation counters** — cancellation state changes and counter updates now run in one transaction.
- **Deduplicated enqueues** — losing operations are removed instead of remaining as empty `pending` operations; fully deduplicated metadata refreshes return `409 admin.metadata.refresh_in_progress`.
- **Scheduled jobs** — failed enqueues no longer advance the deadline, so the next scheduler tick retries them.
- **Provider junctions** — removed the incorrect unique `provider_id` constraint while keeping the composite primary key for duplicate-pair protection.
- **Large operation resume** — all cancelled jobs are now restored using id-cursor pagination, with the operation total set before re-enqueueing.
- **Orphan metadata purge** — switched to id-cursor pagination, rechecks orphan status before deletion, and reports actual deleted rows.
- **Range-file retries** — retries now run missing sidecars, trickplay, analysis and plugin events for every range target.
- **Notification writes** — chunked notification and retention changes are now atomic transactions.
- **Stable pagination** — operations, jobs and relevant cleanup sweeps now use deterministic ID tie-breakers.

### Authentication, profiles & access control

- **Private response cache** — cache and request-dedup keys now include `x-api-key`; GET and HEAD are also kept separate.
- **Protected playback artifacts** — access-controlled artifacts are now `Cache-Control: private`.
- **Quick-connect PIN profiles** — paired devices now receive the correct profile PIN fingerprint for both pairing and voucher flows.
- **API-key PIN bypass** — machine credentials now go through the same profile PIN check as other credential types.
- **Server settings validation** — invalid values now fail with `admin.settings.invalid_value` instead of silently replacing stored values with defaults.
- **Cancelled streaming sessions** — late ffmpeg attach and EOF can no longer revive a cancelled session.
- **Stale download recovery** — interrupted downloads are reconciled at startup; missing sources fail immediately and exhausted retries become failed jobs.
- **Avatar cleanup** — replacing an avatar now removes the previous image when it is no longer referenced.

### Media, playback & subtitles

- **Video-only files** — audio mappings are now optional (`0:a:0?`), allowing silent files to play and download.
- **Remembered audio tracks** — playback decisions now describe the track that is actually mapped, avoiding codec mismatches after resume.
- **Subtitle updates** — changing a subtitle invalidates extracted VTT and cached list/detail responses and removes replaced external files.
- **Streaming logs** — playback logs now use the worker `operationId`, falling back to the session ID only when necessary.
- **Seek activity** — unbuffered seeks now refresh session activity so paused clients are not reaped mid-seek.
- **ffmpeg shutdown** — process-exit waits are bounded, preventing stuck processes from blocking release/shutdown forever.
- **Keyframe probes** — aborted probes are no longer cached as “no keyframe”.
- **Trickplay timestamps** — timestamps are now generated from whole milliseconds, preventing invalid `00:00:60.000` output.
- **Playback suggestions limit** — `/me/playback-suggestions` now enforces its documented 50-ID limit.
- **Image rewrites** — in-place optimized-image changes immediately invalidate source-version caches.
- **Windows image cache** — cache keys no longer contain the invalid NTFS `:` character.
- **Conditional requests** — `If-None-Match: *` and multi-value validators now work correctly, and `304` responses retain validation headers.
- **Compression negotiation** — `q=0` refusals and exact encoding tokens are now handled correctly.

### Scanner & libraries

- **Partially unmounted libraries** — unreachable library roots now block the entire removal phase instead of deleting records from a partially unavailable share.
- **Library language changes** — metadata-language overrides are invalidated immediately after editing.
- **Missing-translation flag** — omitted provider flags no longer reset an existing `hasMissingTranslation` value.
- **Deleted subtitles during scans** — sidecar candidates are existence-checked before import.
- **Episode merge matching** — merges now match by season, episode type and number instead of number alone.
- **Escaped search terms** — `%` and `_` are now treated literally across all relevant search paths.
- **Sidecar-first scans** — `.reelvault.nfo` movie/series/season/episode snapshots are now used as a fallback; standard `.nfo` files still take priority.
- **Semver prereleases** — versions such as `2.0.0-rc.1` now correctly sort below `2.0.0`.
- **Unwatchable paths** — watcher failures are exposed through `getUnwatchablePaths()` and reported to administrators once per failure episode.
- **Watcher fallback** — paths without working filesystem watchers are automatically rescanned using `scanning.watcherFallbackIntervalMinutes` (default `30`, `0` disables it).
- **Manual plugin directories** — plugin upgrades now preserve existing directory names, remove stale duplicates and resolve IDs through the lockfile first.
- **Adaptive transcoding threads** — concurrent transcodes now divide the configured thread budget correctly; a single transcode receives the full budget.
- **Streaming archive extraction** — plugin/server archives are processed entry-by-entry instead of fully buffered in memory, reducing peak memory use and retaining path/type safety checks.
- **Plugin uninstall safety** — the package is removed before its data, preventing a failed uninstall from leaving an installed-but-empty plugin.
- **Plugin notification channels** — channels registered during `setup()` now work; duplicate IDs produce a clear error.
- **Plugin reloads** — worker unregistration now waits for cancellation before a reload can enqueue fresh jobs.
- **Worker-history purge** — operation-owned jobs are preserved while their operation is active.
- **Retried jobs** — progress, start time and result are reset when a job enters its retry backoff.
- **Provider-independent scans** — internal scan operations no longer load provider-priority overrides when unnecessary.
- **Removal-guard deduplication** — shared range-file paths are checked only once.
- **Concurrent cleanup events** — stale-media notifications are emitted concurrently.
- **Sidecar root resolution** — library roots are resolved once per sidecar batch instead of once per media file/episode.
- **Season/episode parsing** — repeated parsing is memoized.
- **Temporary trickplay files** — ownership and rollback are now handled centrally.
- **Scanner matching** — ignore-pattern and video-file detection avoid repeated path/extension work.

### Plugins, workers & operations

- **Failed plugin enqueues** — rollback now removes pending jobs by operation ID before deleting the operation.
- **Plugin artifact quotas** — external media cleanup invalidates cached plugin totals, and concurrent writes are serialized around quota checks.
- **Plugin catalog loading** — repository loading is concurrent instead of serial.
- **SDK shim initialization** — warm plugin loads avoid repeated setup.
- **Runtime mirroring** — filesystem overhead for large plugin trees is reduced.
- **Artifact quota calculation** — totals are aggregated without repeatedly walking individual files.
- **Event emission** — `emit` without subscribers returns earlier.
- **Trickplay enqueueing** — generate-all enqueue overhead is reduced without changing generation itself.
- **Worker deadlines** — trigger-less workers no longer perform no-op `UPDATE`s.
- **Worker scheduler** — scheduler writes are batched into multi-row upserts.
- **Worker counters** — claim counters are aggregated per operation.
- **Cleanup jobs** — retention and stale/plugin-artifact cleanup use batched deletes.
- **Session reaper** — active-job checks use one chunked query per sweep.
- **Worker progress fan-out** — progress/completion events are sent only to admin WebSocket connections.
- **Realtime backpressure** — dropped WebSocket messages are detected; repeatedly dropping connections are closed so clients can reconnect and resynchronize.
- **Worker progress delivery** — client polling is replaced with throttled WebSocket broadcasts; database write frequency is unchanged.
- **Event-loop monitoring** — idle sampling is reduced from every 100 ms to every 1 s.

### Other fixes

- **Read-then-write SQLite transactions** — affected operations now use `BEGIN IMMEDIATE` to avoid `SQLITE_BUSY_SNAPSHOT`.
- **Notification registration** — plugin IDs are bound before `setup()`.
- **Plugin job cancellation on reload** — old workers finish cancellation before the new plugin starts scheduling work.
- **Audio/download lifecycle** — missing audio streams no longer cause ffmpeg failures.
- **Artwork/avatar cache invalidation** — changed sources are invalidated immediately.
- **Log-tail cache** — rotation, truncation and size-cap changes invalidate stale windows before rebuilding.
- **Audit parsing** — repeated status checks reuse parsed results.
- **Production logging** — default logging is now `info`, with debug files created only for `debug`/`trace`.
- **Notification update semantics** — `read:false` is respected and already-read notifications can be updated without a false `403`.
- **Range-file media rematching** — duplicate metadata conflicts now merge movie/episode references before deleting duplicates, preventing cascaded file/history deletion.
- **Playlist/session teardown** — bounded waits prevent stuck ffmpeg processes from wedging shutdown.
- **Library scans** — scanner and processor now use consistent range targets and retry missing post-create side effects.
- **Download recovery** — stale rows are re-enqueued or failed according to source availability and retry budget.

## Performance

The performance work focuses on reducing unnecessary database work, request waterfalls, filesystem operations and repeated per-item processing.

### Database & queries

- **Selective projections** — `?fields=` now selects only requested root columns.
- **Cheaper existence checks** — indexed reads and `EXISTS ... LIMIT 1` replace unnecessary full-row/count work.
- **Index cleanup** — removed redundant prefix indexes and added targeted covering indexes for scanner pagination, downloads, sorting, workers and `created_at` queries.
- **Provider junction lookups** — restored non-unique `provider_id` indexes; 200 lookups on 200k rows dropped from 956 ms to 2 ms (~447×).
- **Incremental statistics** — post-scan `PRAGMA optimize` replaces synchronous full `ANALYZE`; the full analyze remains in daily cleanup.
- **Paginated library statistics** — large per-path scans now use 5,000-row keyset pages, reducing transient heap from 55.3 MB to ~10 MB on a 300k-file library.
- **Streamed catalog scans** — audit/full-refresh workers page IDs instead of loading the full catalog; peak heap dropped from 33.7 MB to 1.5 MB on 300k files.
- **RAM-aware SQLite temp storage** — low-memory hosts use file-backed temp storage and smaller mmap settings; a 2M-row `GROUP BY` dropped RSS growth from 61 MB to 3 MB.
- **Cached worker/trickplay stats** — expensive whole-catalog/grouped stats use short 5 s TTL caches.
- **Batched writes and cleanup** — scheduler writes, worker counters, retention cleanup and catalog refreshes use batched statements.
- **Reduced relation queries** — next-episode and stream-preference resolution now use fewer queries.
- **Cached aggregate counts** — frequently requested admin/collection counts use short-lived caches.
- **FTS maintenance** — repeated title updates create less FTS5 segment growth.

### HTTP & middleware

- **Request-path reuse** — route classifiers reuse the already-parsed pathname.
- **Cached origin/security data** — dynamic origin rules, PIN fingerprints and HKDF secrets are memoized; IPv4 range masks are precomputed.
- **Fewer filesystem checks** — security headers avoid unnecessary `stat` calls on API/plugin/health requests.
- **Batch endpoints** — watchlist hydration, playback suggestions and the composite admin view eliminate client-side request waterfalls.
- **Compression fast paths** — cheap response/content-encoding checks run before full negotiation.
- **Faster header parsing** — single-token `Accept-Encoding` and single-validator `If-None-Match` cases use fast paths.

### Scanner & media processing

- **Memoized parsing** — repeated season/episode extraction and ignore-root normalization are cached.
- **Batch sidecar processing** — roots and ignore patterns are resolved once per batch/root.
- **Concurrent cleanup events** — stale-media plugin notifications no longer wait on handlers one-by-one.
- **Streaming trickplay writes** — sprites are streamed from `BunFile` instead of buffered in memory.
- **Image-cache eviction** — write-order tracking avoids repeated `readdir`/`stat` sweeps; steady-state eviction performs 0 filesystem `stat` calls.

### Plugins & artifacts

- **Concurrent plugin loading** — repository catalogs load in parallel.
- **Cheaper plugin runtime setup** — warm SDK shims avoid repeated initialization.
- **Faster mirroring** — large plugin trees require fewer filesystem operations.
- **Faster quota totals** — artifact totals are aggregated without repeatedly walking files.
- **Cheaper events** — events without subscribers return faster.
- **Faster trickplay enqueueing** — enqueue overhead is substantially lower.

### Logging & caching

- **Logger sanitizer fast path** — benign strings skip deep cloning (~2.2× faster); credential-bearing records retain the safe path.
- **Cache invalidation** — artwork and log-tail caches invalidate immediately when their sources change.
- **Cached audit parsing** — repeated audit status polls reuse parsed results.
- **Lower default log volume** — default `info` logging reduced a 3,000-request browse workload from 1.93 MB to 0.90 MB (~53% less), with no measurable HTTP throughput change.

### Workers & streaming

- **WebSocket progress delivery** — worker progress uses throttled broadcasts instead of client polling.
- **Admin-only fan-out** — worker events are sent only to admin sockets; with 100 connections/1 admin, sends dropped from 2,000,000 to 20,000.
- **Reduced deadline writes** — trigger-less workers no longer write unchanged deadlines.
- **Lower polling frequency** — playlist start-cushion polling dropped from every 20 ms to 100 ms, reducing reads ~100 → ~20 per start.
- **Lean ffmpeg logs** — streaming/transcode runs use `warning -stats`; a 120 s 1080p operation log dropped 6,374 → 3,972 bytes (~38%).

## Performance benchmarks

Representative end-to-end and database measurements. Timed values are p50 unless stated otherwise; HTTP results are medians from three alternating runs.

| Area | Benchmark | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| HTTP | Health, c=50 — throughput | 24,896 req/s | 30,440 req/s | **+22%** |
| HTTP | Health, c=100 — throughput | 24,898 req/s | 32,341 req/s | **+30%** |
| HTTP | Health, c=100 — p50 latency | 3.74 ms | 2.92 ms | **-22%** |
| HTTP | Smart-play, 50 IDs — statements | 151 | 4 | **-97%** |
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
| Sidecars | Saving 20 episode files — lookups | ~44 stmts | 2 | **-95%** |
| Sidecars | Artwork export — unchanged source + target | 18.95 ms | 0.02 ms | **≈-100%** |
| Scanner | `isVideoFile`, 1,000 lookups | 0.65 ms | 0.10 ms | **-85%** |
| Scanner | `matchesIgnorePattern`, 500 paths × 3 patterns | 0.86 ms | 0.21 ms | **-76%** |
| Plugins | Catalog cold load, 3 repositories | 300.8 ms | 100.3 ms | **-67%** |
| Plugins | Runtime mirroring, 2,000 files / 50 dirs | 28.05 ms | 6.2 ms | **-78%** |
| Plugins | Artifact quota totals, 1,000 files | 10.10 ms | 1.13 ms | **-89%** |
| Plugins | Trickplay generate-all enqueue | 183 µs/file | 17 µs/file | **-91%** |
| Admin | Log-tail poll after 3 s idle | 7.94 ms | 0.31 ms | **-96%** |

## Additional measurements

Smaller benchmarks are kept separately so the main table stays focused:

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

# v1.2.1

### Features

- **Trickplay storage stats** — `GET /admin/trickplay/stats` now returns `storageBytes` and `storageBudgetBytes` (the effective core artifact budget) alongside coverage counts, powering the admin usage card.
- **Periodic library rescan** — added `scanning.scheduledScanIntervalHours` (`0` = disabled), which periodically rescans every library as a safety net for network shares where filesystem events never arrive and no watcher error triggers the per-path fallback.

### Fixes

#### Scanning & libraries

- **Generic folders used as show names** — episode files in folders such as `movies`, `downloads`, `tv`, `TV Shows`, `shows`, `series` and `seriale` could be recognized with the folder name as the show. Series recognition now falls back to the episode file's own title.
- **Interrupted scans missed new files** — cancelled/aborted scan checkpoints no longer determine the next scan's workload; every scan recomputes its work from disk.
- **Scan requests could silently no-op** — a scan requested while another was running now queues one catch-up scan after the active scan finishes.
- **Hung mounts blocked scans** — paths whose glob walk exceeds two minutes are skipped for that run instead of holding the scan task and its deduplication key until the 2 h worker timeout.
- **Hung mounts could wedge the watcher** — `stat` calls now have a 15 s deadline. Dead NFS/CIFS mounts are treated as unreliable storage rather than missing files, and watcher reconciliation can no longer remain permanently stuck.
- **Periodic rescan after restart** — scheduled-scan due-ness now comes from persisted library-scan operations instead of an in-memory timer, and recent scans are tracked per library rather than globally.
- **Periodic rescan timer errors** — database failures while checking the scheduled-rescan deadline are logged instead of becoming unhandled rejections from the detached timer.
- **Three-digit seasons** — patterns such as `Show.S012E03` now correctly resolve to season 12 instead of falling back to a movie and being skipped on every scan.
- **Unplayable imports after failed probes** — failed ffprobe results no longer create incomplete media rows that the scanner considers up to date. Such files are skipped with a `probe_failed` finding, shown under "needs attention", and retried on the next scan.
- **New titles hidden by caches** — ingesting a media file now invalidates cached `/v1/metadata` and `/v1/libraries` responses so newly discovered titles appear immediately.
- **Library/media cache invalidation** — library create/update/delete and media update/delete now invalidate affected cached list bodies; deleting a media file also clears the library stats cache.

#### Trickplay & artifacts

- **Scan trickplay operations** — scan/refresh-triggered trickplay generation now joins a single active operation per library instead of creating one operation per file. Late attaches can reopen a just-finished operation rather than leaving it terminal.
- **Built-in trickplay artifact quota** — core trickplay generation is no longer restricted by the per-plugin artifact quota. Built-in generators now use `system.artifacts.coreMaxStorageGb` (`0` = automatic: 5% of the artifacts volume, clamped to 5–100 GB, with a 1 GB minimum free-space floor). Exceeding the budget skips the file with a warning so it can be generated again after space is freed.
- **Artifact error codes** — storage-level artifact errors now use `artifact.*` codes, while plugin quota violations continue to use `plugin.artifact.quota_exceeded`.
- **Trickplay temp directories** — failed temp-directory creation now reports the actual cause instead of a later "sprite is empty" error; deleting an already-removed temp directory is no longer logged as an error.
- **Stale keyframes after file replacement** — keyframe probe buckets now include the file's size/mtime signature, preventing replaced files from using keyframes or cached failures from previous content for up to 30 minutes.
- **Stale local artwork** — missing sidecar image files now skip image synchronization with a warning instead of retrying until the job permanently fails.

#### Operations & concurrency

- **Sidecar rewrite storm** — refreshed titles no longer launch an unbounded fire-and-forget rewrite each. Syncs are coalesced per title to one in-flight run plus at most one re-run and execute under the I/O concurrency semaphore.
- **File refresh lost its technical task** — when a metadata refresh is already running, "refresh file" now reuses that operation while still scheduling the probe/marker refresh.
- **Deduplicated sweeps are observable** — refresh-all, media-audit and library-error checks now log when a request joins an already-running sweep.
- **SQLite write contention** — standalone writes no longer synchronously busy-wait on an open transaction lock. They queue on the transaction lock in JavaScript, while the missing-translation flag is written inside the season/episode transaction, preventing event-loop stalls and `database is locked` failures.
- **Cancelled downloads** — worker-cancelled downloads during rescue/shutdown now log a warning instead of an error.

#### Cache & API consistency

- **Batch cache reads** — `mget`/`getOrSetMany` now return cached `null` values instead of treating them as cache misses.
- **Profile cache invalidation** — profile-scoped ETag invalidation now matches the profile ID segment exactly instead of matching substrings.
- **Admin dashboard library relations** — `/admin/dashboard-view` now returns the full `LibraryWithRelations` contract, including `paths` and file/size statistics. This fixes dashboard cache seeding failures and missing storage breakdown data.

# v1.2.2

### Features

- **Plugins can extend the web UI Content-Security-Policy** — `plugin.json` may declare `csp` sources for `img-src` / `media-src` / `connect-src` / `font-src` / `frame-src` (plain origins only; script and style directives are never extendable). The server validates them and appends them to the SPA policy, so plugin-provided artwork and embedded players load — TMDB/OMDb poster options and YouTube trailer embeds no longer get blocked by the built-in `img-src`/`frame-src`.

### Fixes

- **Watchlist hydration was broken twice over** — `fields` + `hydrate=true` failed response validation (the projection dropped `profileId`/`updatedAt` the hydrated contract requires), and even with that fixed the response union resolved to the deep-partial projected branch first, whose normalization silently stripped every embedded `metadata` card — the page then rendered empty. `fields` is ignored while hydrating and the hydrated branch is matched first.
- **Direct `/index.html` requests missed the same-origin API marker** — only the SPA fallback injected `<meta name="reelvault-api-origin">`; a direct `/index.html` (what the PWA precache fetches) was served raw and cached for an hour, so the installed app shell fell back to the `api.*` subdomain heuristic and its API calls were blocked by `connect-src 'self'`. The HTML entry transformation now applies to direct requests too.
- **Plugin schemas could reference undeclared dialogs** — a `button` or `onMount` `openDialog` action pointing at a dialog missing from `ui.json` produced a dead button (the host silently ignores unknown dialogs). Manifest validation now rejects unknown dialog references in inline schemas and `schemaRef` files.
- **SQLite writes could freeze the server behind an open transaction** — a standalone write on the main connection busy-waited inside SQLite while a transaction held the write lock, blocking the event loop and failing with `database is locked` (observed on scan enqueues, worker cancellation and audit inserts). Every write through the main client now queues on the same in-process lock as transactions — reentrant, so nested writes and prepared statements are covered — and statements issued inside a transaction use the transaction connection instead of the main one.

# v1.3.0

### Features

- **Cancel a running update** — `POST /admin/update/cancel` stops an install that is still downloading, verifying or extracting. The download aborts at once and the run is recorded as `cancelled`, not as a failure, with no failure notice. Once files are being replaced the install runs to completion and the request is refused with `update.not_cancellable`.
- **Server updates wait for playback** — a server install or rollback restarts the process, which ends every stream, so `POST /admin/update/install` and `POST /admin/update/rollback` are refused with `update.blocked_active_streams` (409, with the active stream count) while streams play. Both accept `force: true` to restart anyway. Web UI updates are unaffected because they swap files without a restart.
- **Change password** — `POST /v1/auth/change-password` lets a signed-in user change their password. A wrong current password returns `auth.invalid_current_password` (400, so clients do not treat it as an expired session), a too short or too long one `auth.weak_password`. All other sessions are revoked; the current session stays signed in.
- **Subtitle language priority list** — profiles can set `subtitleFallbackLanguages` (e.g. `en,de`): when no subtitle exists in the preferred language, the next listed language is tried in order instead of playing without subtitles. A fallback equal to the audio language is skipped, and the admin default is configurable (`profiles.defaultPreferences.subtitleFallbackLanguages`).
- **Remove from Continue Watching** — `DELETE /v1/me/continue-watching/:metadataId` hides a title from the row without discarding resume positions (unlike a progress reset). The title comes back as soon as it is played again. Stored as `playback_progress.dismissed_at` (new migration).
- **Rewind on resume** — new profile preference `resumeRewindSeconds` (0–30 s, default `0`) with an admin default (`profiles.defaultPreferences.resumeRewindSeconds`).
- **Plugin UI switches** — administrators can hide a plugin's whole UI or single pages, dialogs, tabs, slot entries, the search provider or the playback pre-roll without disabling the plugin: `GET/PUT/DELETE /v1/admin/plugins/:pluginId/ui`. Hiding a page also drops the tabs, buttons and search results that point at it; an unknown key is rejected with `plugin_ui.unknown_contribution`, changes are audited and the switches are removed when the plugin is uninstalled. Stored in the new `plugin_ui_overrides` table (only hidden items are kept).
- **Liveness and readiness probes** — `GET /v1/health/live` answers while the process runs and probes nothing; `GET /v1/health/ready` returns 200 only while the database responds (503 otherwise). Both are public and cheap, for container and orchestrator health checks; `GET /v1/health` keeps the full subsystem report.
- **Offline password recovery** — `bun run admin:reset-password <email> [--password <value>] [--disable-2fa]` resets a password from the command line when nobody can sign in (the server has no mail transport). Without `--password` a random one is generated and printed once; `--disable-2fa` also removes a lost authenticator. All sessions of the user are revoked.
- **Database maintenance commands** — `bun run db:check` (integrity check), `bun run db:vacuum` and `bun run db:backup [target.sqlite]` (integrity check first, then a consistent snapshot, by default into the backups folder). Stop the server before `db:vacuum`.
- **`bun run doctor`** — checks the usual first-run problems in one go (Bun version, ffmpeg and ffprobe, a writable data directory, free disk space, database integrity and migrations, the bundled web UI), says how to fix each and exits non-zero when something is broken.
- **New server settings** — `stream.hlsMaxMuxingQueueSize` (512–8192; raise it when slow storage aborts a stream with "max muxing queue size exceeded"), `downloads.maxConcurrentPerProfile` (1–5), `trickplay.maxFramesPerFile` (300–5000; a longer movie no longer silently loses its previews), `plugins.blobs.retentionDays` (1–365; caps a plugin's requested blob lifetime) and `plugins.notifications.maxPerDayPerPlugin` (0–1000, `0` blocks plugin notifications). All apply at runtime.
- **Log bundle download** — `GET /admin/logs/bundle` returns a zip with every log file (rotated and FFmpeg logs included) for a support request.
- **Runtime log level** — new setting `system.logs.level` (defaults to `LOG_LEVEL`) changes log verbosity without a restart; the debug log file still requires a boot with debug/trace.
- **Stable plugin slot entry ids** — a `ui.json` slot entry may declare an optional `id` (unique within its slot). Interface switches keep pointing at that entry when other entries are added, removed or reordered; entries without an id keep the key derived from their action. A duplicate id is rejected when the manifest loads.
- **Plugin failure codes** — a plugin that fails to load reports an `errorCode` next to its raw `error` message: a domain error keeps its own code (`plugin.already_installed` for an install that collides with an existing one), an invalid package reports `plugin.manifest_invalid` and any other load failure `plugin.load_failed`. Clients should translate the code, not the message.
- **Unreadable plugin configuration is visible** — the admin plugin endpoints (`GET /admin/plugins`, `GET /admin/plugins/:pluginId`, the plugin enable/disable/reload responses and the dashboard) return `configReadError` (`plugin.config_unreadable`) when a plugin's `config.json` exists but cannot be read. Such a plugin used to run silently on its defaults.
- **Secret presence in plugin configuration** — secret fields of `GET /admin/plugins/:pluginId/config` carry `hasValue`, so the admin panel can show whether a key is set and offer to replace it. The stored value is still never returned.
- **Plugin package details for administrators** — the admin plugin endpoints report each plugin's declared `capabilities`, `installedAt` and `source` (installer-managed plugins), `integrityOk` (the package matched its recorded integrity at the last check, at server start or on install) and `updateAvailable` (an enabled catalog offers a newer version).
- **Failed plugin upgrades roll back** — an upgrade keeps the package it replaces until the new version has loaded once. When the new version does not load, during the install or when the plugin is enabled, the previous package is restored with the configuration saved since the upgrade, and the plugin runs as before (`state: rolled_back`). Uninstalling removes the kept package too.
- **Honest plugin install results** — catalog and upload installs report `previousVersion`, `direction`, `state` and, when the new version did not load, `error` and `errorCode`. Previously a plugin that failed to load right after installation still answered with success.
- **Interface switches are cleaned up after upgrades** — once an upgraded plugin runs, switches that point at contributions it no longer declares are removed. A plugin without an interface manifest keeps its switches.
- **Offline switch for enforced two-factor authentication** — `bun run admin:two-factor-enforcement <on|off>` changes `auth.enforceTwoFactor` in the database. With enforcement on, an account without an authenticator cannot sign in, so an administrator who has not enrolled yet could not switch it off in the panel; this command is the way out. Restart a running server afterwards.
- **Plugin archive dry run** — `POST /admin/plugins/validate` checks an uploaded plugin archive without installing it: the manifest, the entry point, the interface manifest (a malformed one is a warning, as it is at load), the server version floor, and whether installing it would be an install, an upgrade, a downgrade or a reinstall. Nothing is installed, enabled or audited.
- **Profile PIN and avatar can be removed** — updating a profile with `pin: null` removes its PIN and `avatarUrl: null` removes its avatar. Before, the PIN was silently kept, so the profile stayed locked. Omitted fields are left unchanged.
- **Seek debounce is a setting** — `stream.seekDebounceMs` (0–2000 ms, default 300) sets how long the stream waits after the last seek before it jumps. It applies at runtime.
- **Filtered admin marker list** — `GET /media-files/markers` takes `type`, `source` and `q` (matched against the label, file id, plugin id and type) next to `limit`; the filters run in the database query, so the admin markers page no longer loads every marker to filter it in the browser.
- **Trickplay regeneration by scope** — `POST /v1/admin/trickplay/regenerate` with `{ "scope": "library" | "title" | "season", "id", "force"? }` queues previews for one library, one title or one season. Without `force` only files with no previews are queued; with it, existing previews are regenerated too. A request queues at most 2000 files and answers with `matching`, `enqueued` and `remaining`, so a larger scope needs another request.
- **Trickplay regeneration report** — `GET /v1/admin/trickplay/operations/:operationId/report` counts a regeneration operation's outcomes: generated, skipped by the artifact storage budget, skipped for another reason, failed, cancelled and unfinished. Budget skips used to appear only in the server log.
- **Subtitle text search** — `GET /subtitles` takes `q` (up to 200 characters), matched against the label, the language and the media file id; the filter runs in the database query, so a search covers every subtitle instead of only the loaded page.
- **Safer database restore** — a restore first backs up the current database (`preRestoreBackup` in the response), so the state it replaces can be recovered. It is refused with `database.restore_blocked_active_streams` (409) while streams are active, unless the request sets `force: true`. The chosen backup is copied before the swap, so backup rotation cannot remove it mid-restore.
- **Image-based subtitles are named** — asking for the content of an embedded PGS or VobSub track no longer answers with a generic not-found. It returns `subtitle.bitmap_unsupported` (400), and the subtitle rows of such tracks carry `extractable: false`, so clients can hide them. Text tracks are unchanged.
- **Migration status** — `GET /v1/admin/database/migrations` lists the migrations shipped with the server and how many the database has applied, with the newest applied one and the pending ones. Pending migrations run the next time the server starts.
- **Paginated marker list** — `GET /v1/media-files/markers` returns one page of the admin list: `page` picks it, `limit` sets its size (1 to 1000, default 100), and the answer carries `total` and `totalPages`. Before, it was a bare array capped by `limit`. The filters `type`, `source` and `q` apply to the total as well. The NDJSON export is unchanged.
- **Mark all read within a type** — `PATCH /v1/notifications` with `{ "all": true, "type": "…" }` marks only the notifications of that type as read, or as unread with `"read": false`. Without `type` it covers every notification, as before.
- **Stream slots in the live view** — `GET /v1/admin/live-activity` returns `capacity` (`{ limit, active }`): the server-wide stream limit and how many sessions hold a slot now, the same counts that decide whether a new stream is refused.
- **Remove notifications** — `DELETE /v1/notifications/:id` removes one notification from the caller's list, and `POST /v1/notifications/delete` with `{ "ids": [...] }` (up to 200) removes several in one request. Only the caller's own notifications are removed; other ids are ignored, and the response reports `deleted`.
- **Pause and resume scheduled runs** — `PUT /v1/admin/workers/:workerId/enabled` with `{ "enabled": false }` stops a worker's automatic runs (startup, interval, daily and weekly triggers) without touching its queue; `{ "enabled": true }` resumes them and arms the next run from now, so the paused period does not fire as a backlog. Manual runs keep working. Every worker summary carries `scheduleEnabled`, and `nextRunAt` while the schedule is active. Until now nothing could set the flag to false, so a schedule could not be paused.
- **Retry a failed worker job** — `POST /v1/admin/workers/jobs/:jobId/retry` re-enqueues a failed job as a new standalone task with the same payload, priority and dedupe key. The failed job stays in its history. A job that did not fail is refused with `worker.item_not_retryable`.
- **Watchdog recoveries are visible** — `GET /v1/admin/workers/watchdog` reports the polling state and how many orphaned running jobs the watchdog requeued since the server process started, with the time of the last recovery.
- **Paginated worker job list** — `GET /admin/workers/jobs` returns the usual page envelope (`page`, `limit`, `total`, `totalPages`, `data`) instead of a bare array of the newest 100 jobs, and takes `status` and `workerId` filters next to `page` and `limit`.
- **Watchlist bulk changes and clear** — `POST /me/watchlist/bulk` with `{ add, remove }` (up to 500 titles each) adds and removes several titles in one request and answers with the `added` and `removed` counts. A title missing from the catalog refuses the whole request (404), and a title in both lists is `watchlist.bulk_conflict`. `DELETE /me/watchlist` empties the profile's watchlist and answers with `removed`.
- **Log filters** — `GET /admin/logs` takes `module` (the logging module, exact, case-insensitive), `exclude` (drops entries whose text matches) and `from` / `to` (ISO 8601 bounds on the entry time). The time bounds apply to structured entries only; plain-text lines carry no timestamp and are left out when a bound is set.
- **Settings export and import** — `GET /admin/settings/export` returns the current value of every dynamic setting in a versioned JSON document, and `POST /admin/settings/import` applies such a document. Import goes through the same validation and audit as a manual change: an unknown key or an invalid value refuses the whole file, and settings the file does not list keep their values.
- **Resource history window and export** — `GET /admin/resources` takes `hours` (1–168, default 24) for the history and the aggregates, and `GET /admin/resources/export?format=csv|json` downloads every sample of the window, without thinning, as CSV or JSON.
- **Audit search and export** — `GET /admin/audit` takes `q`, one term matched against the resource id and the summary, and `GET /admin/audit/export?format=csv|jsonl` downloads the entries matching the same filters, up to 10 000. A wider export is refused with `admin.audit.export_too_large` instead of being cut short.
- **Download retry, cancel and quota** — `POST /downloads/:id/retry` queues a failed or cancelled download again with the same file and quality and replaces the old row; other states answer `downloads.not_retryable`. `POST /downloads/:id/cancel` stops a pending or running download and removes its partial file. `GET /downloads` reports the profile's `quota` (`usedBytes`, and `maxBytes` where 0 means no limit).
- **Bulk stream termination** — `POST /admin/live-activity/terminate` with `{ sessionIds, reason }` (up to 100 sessions) stops several playback streams. Each session is attempted on its own and reported with `success` or a stable `errorCode`, and the outcome is audited with the reason. The reason of a single stop is limited to 200 characters.
- **Stream limit errors say how full the limit is** — `stream.limit_reached` carries `active`, the number of sessions that already hold a slot under the limit that refused the start, next to `scope`, `limit` and `retryAfterSeconds`.
- **Notification pages** — `GET /notifications/page` returns one page of the account's notifications with `page`, `limit`, `total` and `totalPages`, filtered by `unreadOnly` and `type`. The list endpoint the navbar reads is unchanged.
- **User list filters** — `GET /v1/admin/users` takes `role` (`admin` or `user`) and `status` (`active` or `blocked`) next to the search, so the users page can narrow the accounts.
- **Disk space check before an update** — an install is refused before its download starts when the disk holding the installation has less free space than about five times the archive. The error `update.insufficient_disk_space` carries the required and the free bytes.
- **Database backup before a server update** — before a server update replaces any file, the database is copied (the copy joins the rotated backups) and SQLite's quick check runs on the copy. A failed check stops the update with `update.database_integrity_failed` and nothing is replaced. The install job names the backup until the restarted server takes over.
- **Title link on downloads** — the download views (`GET /v1/downloads`, the status and retry responses and the admin download list) carry `metadataId`, the title of each download's media file, or null when it has none. The list is resolved in one batched lookup. Requires SDK 1.3.0.
- **Watchlist auto-removal** — the profile preference `watchlistAutoRemoveWatched` (off by default; the admin default lives under `profiles.defaultPreferences`) takes a title off the watchlist once its progress turns watched: a movie is finished, or every episode of a series is. The check runs when a file completes. Requires SDK 1.3.0.
- **Watch state scope and bulk marking** — `DELETE /v1/me/media-files/:mediaFileId/playback-progress?scope=file|title` clears only that file with `scope=file`; `title`, the default, still clears every file of its title (all versions of a movie, all episodes of a series). `POST /v1/me/watch-state/bulk` with `{ mediaFileIds, watched }` marks up to 500 files watched (each as a single update does) or unwatched in one request; one unknown id rejects the whole request. Requires SDK 1.3.0.
- **Session log download** — `GET /v1/admin/live-activity/:sessionId/log` returns the FFmpeg logs of an active playback session as one zip: every operation log the session wrote, plus `timeline.json` with the start, end, exit code and error of each run. The archive stops adding logs past 64 MB and records the cut in the timeline. Only active sessions can be downloaded.
- **Orphaned download files are removed** — the daily download sweep also deletes the artifact directory of a download whose row no longer exists. A crash between deleting the row and its file used to leave that directory behind. Directories not named after a download id are left alone.
- **Update history and environment** — `GET /v1/admin/update/history` lists the installs and rollbacks of the server and the web UI, newest first, with their versions, status, the administrator who started them and the error of a failed run. A run still open when the server starts is settled then: a server run succeeded if the server now runs the version it installed, any other run is marked as interrupted. `GET /v1/admin/update/status` reports `environment`: the container engine (`docker`, `podman` or none), whether the server runs without root and whether systemd manages the unit as a `user` or `system` unit. A Podman container is detected as a container install, like Docker, so in-place updates are refused there.
- **Audit filter options** — `GET /v1/admin/audit/options` lists the resource types in the audit log and the administrators who wrote entries, so the audit page can offer them as dropdowns. Accounts that no longer exist are listed by id; entries without an actor are left out.
- **Audit activity per administrator** — `GET /admin/audit/summary` takes the audit filters and returns each administrator's activity: totals per action (create, update, delete), the latest entry and the administrator's name, busiest first. Up to 50 administrators are listed; entries without an actor group under a null actor.
- **Admin download list is paged** — `GET /admin/downloads/jobs` returns one page of every user's download jobs (`page`, `limit`, `total`, `totalPages`, `data`) with the number of jobs per status in `counts`, and takes a `status` filter. It used to return up to 500 jobs in a `jobs` array.
- **Marker export and import** — `GET /media-files/markers/export` downloads the timeline markers matching the admin filters as NDJSON, one marker per line, up to 50 000. `POST /media-files/markers/import` (sent as text/plain) replaces the markers of each media file the file names. The whole file is checked first: an invalid line or an unknown media file refuses it, and the error names the line.
- **Setting change tracking** — each custom setting records when it was saved (`updatedAt`) and by which administrator (`lastModifiedBy`). Saving or resetting settings sends a `settings:changed` event with the changed keys to the administrator sessions, and a migration adds the `last_modified_by` column.
- **API key rotation and editing** — `POST /admin/api-keys/:id/rotate` replaces a key's secret in one statement: the new secret is returned once, the old one stops working at once, and the key keeps its name, scope, expiry and creator (its last-used time resets). `PATCH /admin/api-keys/:id` renames a key or changes its expiry (`expiresAtDays`, or null for no expiry). The list names each key's creator (`createdByName`).
- **Remove trickplay previews** — `DELETE /admin/trickplay/media/:mediaFileId` removes one file's core trickplay previews, and `POST /admin/trickplay/media/delete` does up to 500 files at once. Files without previews are left alone, and each removal is audited. `GET /admin/trickplay/artifacts/stats` counts the stored artifact rows per owner and kind.
- **Database backup download and integrity check** — `GET /admin/database/backups/:fileName/download` downloads an existing backup (names that could leave the backups folder are refused). `GET /admin/database/integrity` runs SQLite's quick check and lists what it reports, and `POST /admin/database/optimize` refreshes the planner statistics. Creating and deleting a backup by hand are audited with `origin: manual`.

- **Plugin registration limits** — a plugin may register at most 64 HTTP routes, 32 jobs, 32 scheduled tasks and 128 metadata providers, subtitle providers or media analyzers. Past a cap the plugin's load fails with a `plugin.registration_limit.*` code instead of growing the route table or job queue without bound.
- **Two-factor API responses are documented** — the disable, sign-in verification (authenticator and backup code) and backup-code endpoints document their success responses, including the session token and user returned on sign-in.
- **Bounded watchlist status requests and boolean library siblings** — `GET /me/watchlist/statuses` refuses more than 500 titles per request (`watchlist.statuses_too_many`) and caps the query length; `siblings` on the library endpoint is a boolean query value (`true` / `false`).
- **Library scan and download time limits are settings** — `workers.definitions.libraryScan.timeoutMs` and `workers.definitions.downloadsProcess.timeoutMs` (1 minute to 1 day, default 2 hours) replace the fixed constants and apply to work started after the change.
- **Per-path scan time limit is a setting** — `scanning.pathScanTimeoutMs` (10 s to 1 h, default 2 minutes) sets how long one library path may take to walk before the scan skips it. A dead network mount can no longer hold a scan; the new limit applies from the next scan.
- **Profile PIN status for the owner** — `GET /profiles/:id/pin` returns `{ hasPin }` for a profile the user owns, so settings can offer to remove the PIN. The PIN itself is never returned.
- **Notification channels deliver in parallel with a time limit** — a plugin's external notification channel that does not answer within 15 seconds is abandoned and logged, and a slow channel no longer holds up the channels after it.
- **Plugin configuration reset, export and import** — administrators restore defaults for one field or all fields (`POST /admin/plugins/:id/config/reset`), export the configuration without its secret fields (`GET /admin/plugins/:id/config/export`) and import it again (`POST /admin/plugins/:id/config/import`). An import never overwrites a secret. Uninstalling a plugin keeps a backup of its configuration, and installing the same plugin again restores it.
- **Public server capabilities** — `GET /capabilities` returns whether trickplay and downloads are switched on, without a session, so a client can hide features that the server does not offer.
- **Setting units and restart flags; monitoring applies at once** — settings report their unit and whether a change needs a restart (`auth.sessionLifetimeDays`, `stream.hlsSegmentDurationSeconds`). Changing the resource monitoring interval or enabling and disabling monitoring re-arms the sampler immediately instead of waiting for a restart.
- **Refuse a plugin's CSP sources** — `PUT /admin/plugins/:id/csp` with `{ "enabled": false }` stops an installed plugin's manifest from adding sources to the page's content security policy. The choice is stored with the installed package, survives restarts and upgrades, and applies at once. A plugin without an installer record cannot be changed.
- **Enable and disable plugins in bulk** — `POST /admin/plugins/bulk` with `{ enabled, pluginIds }` (up to 100 plugins) attempts each plugin on its own and reports an outcome per plugin, so one failure does not stop the others.
- **Pin a plugin's version** — `PUT /admin/plugins/:id/pin` with `{ pinned: true }` keeps the installed version: the catalog reports it as installed and offers no update. The choice survives restarts and upgrades; installing a newer version explicitly stays possible.
- **Catalog says which repositories it could not read** — `GET /admin/plugins/catalog` returns the plugins and, separately, the repositories that could not be read, each with an error code, so a missing plugin is no longer silent.

### Fixes

- **Admin user list and creation status** — the user list clamps a page below 1 to the first page instead of rejecting it, and creating a user answers `201 Created`.
- **Wrong year for titles containing a year** — "Blade Runner 2049 (2017).mkv" was recognised as "Blade Runner" (2049) because the first year-like number won. The last year before the release tags now wins, so the title keeps its own number.
- **Year-first file names were not recognised** — `(1993) Jurassic Park` and `1993 - Jurassic Park` ended up with the year inside the title and no release year, which made provider matching fail.
- **Provider id tags polluted titles** — `[tmdbid-…]`, `{imdb-…}` and `[tvdbid-…]` tags are now removed from names (previously only harmless when a year followed them), and "Uncut" is ignored when matching edition titles.
- **Server-side response bugs were reported as client errors** — a response that failed its own schema was returned as `400 validation.invalid_request`, sending clients to "fix" a request that was fine. It is now `500 internal` (and logged), while genuinely invalid request input stays 400.
- **Stale admin catalog after metadata edits** — choosing or uploading artwork, creating, deleting, merging titles and purging orphans did not flush cached API responses, so the admin lists kept showing the old state for up to a few minutes. Every one of those writes now invalidates the read caches.
- **Catalog lists stayed stale after a metadata refresh or scan** — a refresh did not flush cached list responses, and the scan/ingest flush only covered titles and libraries. People, companies, genres, keywords and collections are now flushed too, from one shared list of catalog routes.
- **Genre, company, keyword, person, episode and collection edits left cached lists stale** — creating, editing, deleting, reordering or refreshing these did not flush the cached catalog responses, so lists kept the old data until the cache expired. They now do.
- **New notifications did not appear until the list cache expired** — creating a notification only reset the unread badge; the cached notification list of the recipient was kept. It is now flushed together with the badge, also for the batched "new episode" notifications.
- **Recommendations and insights ignored a just-finished title** — finishing a movie or episode did not clear the profile's cached discover view and insights, so "Discover" and the insights page lagged behind the watch history. They are now cleared when a title completes.
- **Old avatar for a few seconds after changing it** — the authenticated-profile cache was cleared before the avatar transaction committed (and not at all for the avatar write), so the previous avatar could be served for up to 10 seconds. It is now dropped after the commit.
- **Changed profile defaults could be served from cache** — saving or resetting `profiles.defaultPreferences.*` settings now flushes cached API responses that embed effective preferences.
- **Library metadata language / provider order changes were ignored by the title lookup cache** — the aggregated provider lookup was cached per library but not per metadata language, and used the global provider order for its key, so changing a library's language or provider priorities kept returning the old result until the cache expired. Both are part of the key now.
- **Unbounded per-library provider cache and a lingering timer** — the per-library provider override cache grew with every library ever read (now capped at 200 entries), and the API key "last used" throttle timer could keep the process alive during shutdown (now unref'd).
- **Raw better-auth messages leaked through account endpoints** — a duplicate email on register, a blocked account on login, a too short password on setup and every failure of the admin user actions (create, reset password, change role, block, delete) came back as better-auth's English `{ message }` or an unhandled error. They now use stable codes: `auth.email_registered`, `auth.weak_password`, `auth.invalid_email`, `auth.user_banned`, `auth.invalid_credentials`, `auth.request_rejected`, with ordinary 403/404/500 for the rest.
- **Download errors had no codes and the wrong status** — "downloads disabled" was a 400 and "already downloading" / "quota exceeded" were 400s with prose only. They are now `403 downloads.disabled`, `409 downloads.in_progress` and `409 downloads.quota_exceeded` (with `maxBytes`/`usedBytes`), plus `downloads.media_file_required` and `downloads.duration_unknown`. Internal insert failures (notification, download, worker operation, metadata, image) are `500 internal` instead of 404/409.
- **Stream limits and throttling were inconsistent and gave no back-off hint** — a full server answered 429 without a code, while a full per-user quota answered 409. Both are now `429 stream.limit_reached` with `{ scope: "server" | "user", limit, retryAfterSeconds }`, a too quick session start is `429 stream.creation_throttled`, and every 429 that knows its wait now also sends the standard `Retry-After` header (exposed to browsers through CORS). A missing active profile is `401 auth.profile_required` on every streaming endpoint (it was 400 or 403 on some).
- **API reference corrections** — 403 is documented on every admin-only media, library, metadata, subtitle and image route; the admin downloads list, two-factor endpoints and playback heartbeat have descriptions and response schemas; the worker trigger docs no longer mention a non-existent `cron` type; the markers `limit` is described correctly (applied in the query); all admin modules and the events stream are tagged in the OpenAPI document.
- **Disabled plugins kept serving their UI** — the plugin UI asset endpoint answered for plugins that were disabled or failed to load; it now returns `404 plugin.not_found` unless the plugin is enabled.
- **Upgrading a disabled plugin re-enabled it** — installing a newer version (or reinstalling) wrote a fresh install record without the disabled flag, so a plugin the administrator had switched off started again at the next boot. The disabled state is now carried over.
- **Plugin routes shared one rate-limit bucket** — every plugin endpoint counted against the same per-profile budget, so one chatty plugin could lock a profile out of all the others. The limit is now tracked per plugin.
- **Changing the HLS segment length could corrupt running streams** — the setting was read live, so a change mid-session made open sessions compute segment names and buffer positions with a different grid than their ffmpeg process used. It is now fixed for the lifetime of the server process and a changed value applies after a restart.
- **Clearer start-up failures** — an invalid environment value now prints one line per variable (`APP_PORT: ...`) with a hint instead of a raw schema error, a port that is already taken says so and names `APP_PORT`, and `.env.example` points `APP_PUBLIC_URL` at the default port 3030 instead of 3000.
- **Typos locked people out of signing in** — failed password attempts counted against the per-account limit even after a correct sign-in. A successful sign-in now resets the counter.
- **Deleting the active profile left stale cookies** — the `current_profile_id` and PIN-unlock cookies of a client that deleted the profile it was using stayed in the browser, so later requests kept pointing at a profile that no longer existed. Both are cleared now.
- **Required plugin settings could be saved blank, and config problems were silent** — saving a plugin configuration now rejects a `required` field that is still empty (`plugin.config_invalid` with the field name; a value already stored counts). An unreadable `config.json` and a plugin that failed to reload after a save are now logged instead of silently falling back to defaults.
- **Clearer settings feedback** — saving a system setting with a value outside its range now reports the allowed `min`/`max` (`admin.settings.invalid_value`), an unknown key is rejected with `admin.settings.unknown_key` instead of being silently dropped (the admin saw "saved" for a setting that never changed), and number settings are listed with their bounds.
- **Broken plugin packages were invisible** — a plugin directory whose `plugin.json` is missing or invalid only logged an error; the admin plugin list showed nothing. It is now listed as failed (phase `manifest`) under its directory name, with the error, and the entry disappears once the package is fixed and loaded.
- **Unwritable data directory showed a raw filesystem error** — a `ROOT_DIR` that cannot be created or written (permissions, read-only mount, typo) now prints the directory, the reason and how to fix it and exits, instead of an `EACCES` thrown from deep inside module loading.
- **`bun dev` ran with production settings** — the development script now sets `NODE_ENV=development`, so pretty logs and dev-only diagnostics work without editing `.env`. The development default bind is `0.0.0.0`; when setup is still pending and no setup token is configured, boot now warns that the setup wizard is reachable from the network.
- **Silent configuration typos at boot** — allowed-origin entries that can never match (a broken scheme, spaces) and an FFmpeg older than the recommended 6.x are now reported as warnings instead of failing silently later.
- **`GET /me` required a profile** — the account bootstrap call failed with `401 auth.profile_required` before a profile was selected, although the profile picker needs it first. It now requires only a session and returns `profile: null`; every other `/me` route still requires an active profile.
- **Marking an already watched file again inflated the history** — the manual "mark watched" endpoint inserted a new row on every call, so watch counts, insights and "Wrapped" grew on repeats. A full-watch row is now idempotent per profile and file, matching the playback completion path.
- **Stale catalog ids returned 500s** — adding a removed title to the watchlist, rating it, or syncing it as watched surfaced a raw foreign-key failure; these are now `404 entity.not_found` with the metadata or file id.
- **Saving a value equal to the default stored an override** — saving e.g. `ffmpeg.path = ffmpeg` shadowed the `APP_FFMPEG_PATH` fallback and survived a reset; a value equal to the definition default now drops the stored override instead.
- **Empty strings were invalid for settings whose default is empty** — `ffmpeg.hwaccelDevice`, `plugins.http.allowedDomains` and the empty profile language defaults rejected `""` with `admin.settings.invalid_value`; they accept it now, while settings with a non-empty default still reject an empty input.
- **Watcher-related settings needed a restart** — changing `scanning.watcherFallbackIntervalMinutes` or `scanning.scheduledScanIntervalHours` kept the watcher timers on their old value; the watchers re-arm when either changes.
- **Image uploads ignored a raised size limit** — the artwork upload route hard-capped bodies at 20 MB, so `images.maxUploadBytes` above that was unreachable; the route now accepts up to a protocol ceiling and the live setting decides, failing with `images.upload_too_large` and the allowed size.
- **Orphaned subtitle renditions were never swept** — extracted `.vtt` files left behind by a crash or a restored database stayed on disk forever; a daily cleanup now deletes files that have no subtitle row (with a 10-minute grace period for in-flight extractions).
- **Library scans queued behind bulk work** — a scan request could wait until every pending ingest/refresh job had run; scans now enqueue with a higher queue priority than bulk background jobs.
- **Settings changes were audited with an empty “after”** — every update wrote `{}` instead of the saved values (a `Map` does not serialize), so the audit trail showed what changed but not to what; the recorded values are now real.
- **Playback diagnostics could describe the wrong encoder** — after an admin changed `ffmpeg.hwaccel` or the tone-mapping method, a running session reported the new setting while its ffmpeg process used the old encoder. A session now captures its encoder environment when it is created.
- **Opaque HLS errors** — a segment that never appeared, a playlist being rebuilt and a seek before the session was ready all returned code-less errors; they now carry `stream.segment_not_found` (with the segment name, incl. init segments), `stream.segment_not_ready`, `stream.playlist_rebuilding` and `stream.not_ready` so clients can translate and retry correctly.
- **The log list ignored older entries silently** — when a log file exceeds the served 2 MiB window, search and pagination only see the tail. `GET /admin/logs` now reports `truncated` and `windowBytes` so the viewer can say so.
- **Marking an episode watched didn't continue the series** — the manual “mark watched” endpoint only wrote history, so Continue Watching never offered the next episode (its row builder only advances when the current file is completed). A full watch now marks the file's progress complete; a partial watch and duplicates behave as before.
- **"Not interested" didn't stick** — a title rated 0 ("not interested") still showed up in Discover recommendations and Trending; it is now excluded from both.
- **Server failures could go unnoticed** — a worker job that exhausted its retries, a failed update install or rollback and disk/memory pressure were broadcast to the admin dashboard only while a browser was connected. They are now persisted notifications for administrators (with a 6-hour de-duplication per failure), so a missed window no longer loses the warning.
- **Library scans reported no removed files and ever-zero failures** — the scan result hardcoded `failedFiles: 0` and had no removed count at all, so administrators could not see how much the scan removed. The scanner now returns the files it actually removed (empty when removals were skipped by the mass-removal guard or unavailable storage) and the scan result carries that count. `analyzedFiles` stays 0 because the scan only diffs; analysis happens in the ingest jobs.
- **Refresh and identify ignored the library's metadata language** — refreshing a title, refreshing its artwork and reassigning a file to a provider entry asked the provider for the default language, so a library with a metadata language override got different titles and overviews after a refresh than after its scan. These requests now use the override of the library that holds the title's files.
- **Episodes missing their overview** — a season payload can list an episode without its overview; the import now also asks for the single episode and takes its overview when it has one.
- **Provider cache TTL applies without a restart** — changing `plugins.providers.detailsCacheTtlMs` only took effect after a restart, because the provider result caches read their TTL once. They are rebuilt when the setting changes.

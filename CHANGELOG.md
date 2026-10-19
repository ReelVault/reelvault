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

## Features

### Libraries & metadata

- **Library scan progress** — `GET /libraries/scan-progress` reports libraries with queued or running scans. Progress reflects the share of enqueued work handed to ingest and refresh queues; it remains `null` while files are still being discovered.
- **Ignore scan findings** — admins can ignore files that could not be ingested and restore them later. `GET /libraries/:libraryId/scan-findings` supports a `status` filter and returns counts for both statuses; `PATCH /libraries/:libraryId/scan-findings` ignores or restores a finding.
- **Candidate matches for scan findings** — `GET /libraries/:libraryId/scan-findings/candidates?filePath=` searches metadata providers using the title and year parsed from a filename. Available only for `no_metadata_match` findings and runs on demand, never during a scan.
- **Scan all libraries and cancel scans** — `POST /libraries/scan` queues every library scan in order. `POST /libraries/:libraryId/scan/cancel` cancels queued and running scans, including path scans and catch-up passes.
- **Library path health and error-check results** — `GET /libraries/health` reports path availability, watcher coverage, stable error codes and the last scan time. `GET /libraries/check-errors/:operationId` reports the progress and results of an FFmpeg decode-error check.
- **Unified metadata match threshold** — `metadata.minMatchScore` sets the minimum accepted metadata match score (default `0.45`). The confident-match level remains `0.7`, with a `0.15` margin; review lists, mismatch audits and admin counts use a fixed threshold of `0.75`.
- **Catalog status list** — `GET /metadata/statuses` returns distinct, non-empty catalog statuses in sorted order for use in status filters.
- **Named TMDB IDs** — `[tmdbid-…]` tags in filenames, folder names or NFO files resolve the exact TMDB title before a title search. Unknown IDs fall back to searching by title.
- **Bulk metadata refresh** — `POST /episodes/bulk-refresh`, `POST /people/bulk-refresh` and `POST /media-files/bulk-refresh` accept up to 50 IDs and report individual outcomes. Episode and people refreshes run sequentially; media-file refreshes are queued and return `202`.
- **Bulk artwork refresh and image-cache purge** — `POST /metadata/bulk-refresh-images` refreshes posters and backdrops for up to 50 titles. `POST /admin/image-cache/purge` removes optimized image copies and reports removed files and bytes; originals remain untouched.
- **Bulk deletion of media files and titles** — `POST /media-files/bulk-delete` and `POST /metadata/bulk-delete` process up to 50 IDs and report each result. Active streams block deletion unless `force` is set; files on disk are not deleted.
- **Marker management and export/import** — `GET /v1/media-files/markers` supports pagination and `type`, `source` and `q` filters. `GET /media-files/markers/export` exports matching markers as NDJSON (up to 50,000); `POST /media-files/markers/import` replaces markers for the named media files after validating the entire input.
- **Subtitle search and management** — `GET /subtitles` supports database-backed `q` searches up to 200 characters. Admins can delete up to 200 subtitles with `POST /subtitles/bulk-delete` or upload external SRT, WebVTT and ASS subtitles through `POST /subtitles/upload` (up to 1 MB).
- **Subtitle provider controls** — admins can enable or disable providers using `PATCH /subtitles/providers/:providerId`. Disabled providers are not searched, and their downloads are refused with `plugin.subtitle.provider_disabled`. Provider state is returned by `GET /subtitles/providers` without browser caching.
- **Image-based subtitle handling** — embedded PGS and VobSub tracks return `subtitle.bitmap_unsupported` (`400`) and expose `extractable: false`, allowing clients to hide tracks that cannot be extracted as text.

### Playback, streaming & profiles

- **Per-profile bitrate cap** — `maxStreamingBitrateKbps` limits requested stream bitrate (`0` = unlimited, default). The lowest of the profile, client and server per-stream limits applies.
- **Per-profile HDR mode** — `hdrMode` supports `auto` (default, preserving HDR passthrough where supported) and `toneMapToSdr` (always convert HDR sources to SDR). Stored with existing profile preferences; no migration is required.
- **Transcoded audio settings** — `ffmpeg.audioBitrateKbps` (64–512, default `192`) controls transcoded AAC bitrate, while `ffmpeg.downmixToStereo` (default `false`) enables stereo downmixing. Defaults preserve previous output.
- **Playback view limits** — playback responses expose `effectivePreferences`, including the effective bitrate cap and HDR mode.
- **Subtitle language fallback** — profiles can configure `subtitleFallbackLanguages` (for example, `en,de`) to try languages in order when the preferred subtitle is unavailable. A fallback matching the audio language is skipped; the admin default is configurable through `profiles.defaultPreferences.subtitleFallbackLanguages`.
- **Resume rewind** — the `resumeRewindSeconds` profile preference (0–30 seconds, default `0`) controls how far playback rewinds when resuming. An admin default is available under `profiles.defaultPreferences.resumeRewindSeconds`.
- **Hide rating overlays per profile** — `hideRatingOverlay` is a new profile preference, disabled by default and stored with existing preferences.
- **Remove titles from Continue Watching** — `DELETE /v1/me/continue-watching/:metadataId` hides a title without clearing its resume position. It returns when played again. The dismissal is stored in `playback_progress.dismissed_at` (new migration).
- **Profile watch-state management** — `DELETE /v1/me/media-files/:mediaFileId/playback-progress?scope=file|title` clears progress for one file or the whole title. The default `title` scope clears every version of a movie or every episode of a series. `POST /v1/me/watch-state/bulk` marks up to 500 media files watched or unwatched.
- **Playback session improvements** — at the session limit, starting another version of a title already being streamed by the same profile reclaims its existing slot. Heartbeats preserve position and pause state, playback responses expose `heartbeatIntervalMs` (10 seconds), and `GET /playback-sessions/mine` returns `positionSeconds` and `paused`. `DELETE /playback-sessions/mine` closes all sessions belonging to the calling profile.
- **Stream capacity and termination** — `GET /v1/admin/live-activity` exposes `capacity.limit` and `capacity.active`. `POST /admin/live-activity/terminate` can stop up to 100 sessions in one request, reporting each result and auditing the supplied reason.
- **Recently ended playback sessions** — `GET /admin/live-activity/history` lists up to 200 recently ended sessions with title, profile, reason, start/end times and duration. History is in memory and resets on restart.
- **Playback session logs** — `GET /v1/admin/live-activity/:sessionId/log` downloads an active session's FFmpeg logs as a ZIP, including `timeline.json`. The archive is capped at 64 MB and records truncation in the timeline.

### Downloads, watchlist & notifications

- **Queued downloads** — requests exceeding `downloads.maxConcurrentPerProfile` wait for a running slot instead of being rejected. Each profile can have up to 200 waiting downloads; excess requests return `downloads.queue_full`.
- **Season downloads** — `POST /downloads/seasons` queues each episode using its default file and reports per-episode outcomes. A season estimated to exceed available quota is refused with `downloads.season_exceeds_quota` unless `force` is set.
- **Download retry, cancellation and quota** — `POST /downloads/:id/retry` retries failed or cancelled downloads, replacing the old row; `POST /downloads/:id/cancel` stops pending or running downloads and removes partial files. `GET /downloads` reports quota usage through `usedBytes` and, when limited, `maxBytes`.
- **Duplicate download protection** — requesting a title already queued or downloading for the profile returns `downloads.in_progress` (`409`) instead of creating a duplicate. Season downloads report these conflicts per episode and continue queueing the remaining episodes.
- **Download title links** — download lists, status/retry responses and admin download lists expose `metadataId` for the downloaded title, or `null` if unavailable. The list uses a batched lookup. Requires SDK 1.3.0.
- **Automatic watchlist cleanup** — `watchlistAutoRemoveWatched` (off by default, with an admin default under `profiles.defaultPreferences`) removes titles when their watched state completes: a movie finishes or every episode of a series is watched. Requires SDK 1.3.0.
- **Bulk watchlist operations** — `POST /me/watchlist/bulk` adds and removes up to 500 titles per list, returning `added` and `removed` counts. Missing titles reject the request; overlapping add/remove IDs return `watchlist.bulk_conflict`. `DELETE /me/watchlist` clears the profile's watchlist.
- **Notification pagination and deletion** — `GET /notifications/page` returns paginated notifications with `unreadOnly` and `type` filters. `DELETE /notifications/:id` removes one notification; `POST /notifications/delete` removes up to 200. Only the caller's notifications are affected.
- **Mark notifications read by type** — `PATCH /v1/notifications` with `{ "all": true, "type": "…" }` marks only one notification type as read or unread. Without `type`, behavior remains global.
- **Mute notification types per profile** — `mutedNotificationTypes` excludes selected types from notification lists, pagination and unread counts, and suppresses their live alerts. No migration is required.

### Administration, audit & observability

- **Rate-limit headers and route overrides** — rate-limited routes return `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` on successful responses as well as refusals. `network.rateLimit.routeOverrides` allows bounded overrides for designated read-only admin and library routes, capped at 10 times each route's built-in budget. Sensitive authentication, session, API-key, setup, restore, install and plugin-install budgets remain fixed.
- **Filtered and paginated admin lists** — marker lists support `type`, `source` and `q`; worker jobs support `status`, `workerId`, `page` and `limit`; admin download jobs support `status` and pagination with per-status counts. The admin user list supports `role` and `status` filters.
- **Admin log search and export** — `GET /admin/logs` supports exact case-insensitive `module`, text `exclude`, and ISO 8601 `from`/`to` filters. Time filters apply to structured entries only. Responses expose `truncated` and `windowBytes` when the served log window is limited to 2 MiB. `GET /admin/logs/bundle` downloads all logs, including rotated and FFmpeg logs, as a ZIP.
- **Log cleanup preview** — `DELETE /admin/logs/cleanup?dryRun=true` counts files that would be removed without deleting anything or recording an audit entry.
- **Resource monitoring history and export** — `GET /admin/resources` accepts `hours` from 1 to 168 (default 24); `GET /admin/resources/export?format=csv|json` exports every sample in the selected window without thinning.
- **Audit search, summaries and export** — `GET /admin/audit` supports `q`; `GET /admin/audit/options` returns available resource types and administrators; `GET /admin/audit/summary` aggregates each administrator's activity. `GET /admin/audit/export?format=csv|jsonl` exports matching entries up to 10,000 and refuses larger exports with `admin.audit.export_too_large`.
- **Setting change tracking** — custom settings record `updatedAt` and `lastModifiedBy`. Saving or resetting settings emits `settings:changed` with changed keys to admin sessions.
- **Settings export/import** — `GET /admin/settings/export` exports dynamic settings in a versioned JSON document; `POST /admin/settings/import` validates and audits the entire import, rejecting unknown keys or invalid values without partially applying it. Unlisted settings remain unchanged.
- **Runtime log level** — `system.logs.level` changes log verbosity without restarting the server; debug log-file creation still requires debug/trace to be enabled at startup.
- **Health probes** — `GET /v1/health/live` reports whether the process is running, while `GET /v1/health/ready` returns `200` only when the database responds (`503` otherwise). Both are public and lightweight; `GET /v1/health` retains the full subsystem report.
- **Public server capabilities** — `GET /capabilities` reports whether trickplay and downloads are enabled, allowing clients to hide unavailable features without a session.
- **Migration status and database integrity** — `GET /v1/admin/database/migrations` lists shipped and applied migrations. `GET /admin/database/integrity` runs SQLite's quick check, and `POST /admin/database/optimize` refreshes planner statistics.
- **Database backup management** — `GET /admin/database/backups/:fileName/download` downloads an existing backup while rejecting path traversal. Manual backup creation and deletion are audited.
- **Database backup upload** — `POST /admin/database/backups/upload` accepts SQLite backups up to 512 MB, validating that they open, pass `quick_check` and contain a ReelVault migration journal. Uploads are disabled by default and require `system.database.backupUploadEnabled`; invalid files return `database.backup_invalid`.
- **Safer database restore** — restore first backs up the current database and returns the backup as `preRestoreBackup`. It is blocked during active streams unless `force: true`; the selected backup is copied before the database swap.
- **Worker history and controls** — `POST /admin/workers/purge-history` supports `dryRun` to preview the number of operations and jobs that would be removed. `PUT /v1/admin/workers/:workerId/enabled` pauses or resumes scheduled runs without clearing the queue; manual runs remain available.
- **Worker job recovery and watchdog** — `POST /v1/admin/workers/jobs/:jobId/retry` retries failed jobs as new standalone tasks. `GET /v1/admin/workers/watchdog` reports polling state and orphaned jobs requeued since startup.
- **Trickplay regeneration by scope** — `POST /v1/admin/trickplay/regenerate` supports one library, title or season, with optional `force`. Requests queue at most 2,000 files and return `matching`, `enqueued` and `remaining`. `POST /admin/trickplay/regenerate` also supports up to 50 titles in one operation.
- **Trickplay regeneration reporting and cleanup** — `GET /v1/admin/trickplay/operations/:operationId/report` distinguishes generated, budget-skipped, otherwise skipped, failed, cancelled and unfinished files. `DELETE /admin/trickplay/media/:mediaFileId` removes one file's previews; `POST /admin/trickplay/media/delete` removes up to 500. Dry-run mode counts affected previews without deleting or auditing. `GET /admin/trickplay/artifacts/stats` groups stored artifact rows by owner and kind.
- **Update history and environment reporting** — `GET /v1/admin/update/history` lists server and web UI installs and rollbacks. `GET /v1/admin/update/status` reports the container engine, root status and systemd unit type. Docker and Podman installs are detected as containers and refused in-place updates.
- **Update cancellation and stream protection** — `POST /admin/update/cancel` cancels an update while downloading, verifying or extracting. Once files are being replaced, cancellation is refused with `update.not_cancellable`. Server installs and rollbacks are blocked with `update.blocked_active_streams` (`409`) while playback is active, unless `force: true`; web UI updates are unaffected.
- **Update disk-space and database checks** — updates are refused before download when free space on the installation disk is below approximately five times the archive size. Before replacing files, the database is backed up and checked; an invalid copy stops the update with `update.database_integrity_failed`.
- **Offline account recovery** — `bun run admin:reset-password <email> [--password <value>] [--disable-2fa]` resets a password when nobody can sign in. Without `--password`, a random password is generated and printed once. All user sessions are revoked.
- **Offline two-factor enforcement control** — `bun run admin:two-factor-enforcement <on|off>` changes `auth.enforceTwoFactor` directly in the database. Restart the running server after using it.
- **Two-factor backup-code count** — `GET /v1/auth/two-factor/backup-codes` reports `remaining` without exposing the codes. Enforcement cannot be enabled through settings or the offline CLI until an administrator has enrolled in two-factor authentication.
- **Admin user sessions** — `GET /admin/users/:userId/sessions` lists unexpired sessions without exposing tokens. Admins can revoke one session or revoke all sessions for up to 100 users. User rows include `lastActiveAt` and `activeSessionCount`.
- **API-key rotation and editing** — `POST /admin/api-keys/:id/rotate` replaces a key's secret atomically and returns it once, preserving its other properties. `PATCH /admin/api-keys/:id` edits the name or expiry, and list responses include `createdByName`.
- **Bulk stream termination** — `POST /admin/live-activity/terminate` stops up to 100 playback sessions, reports each outcome independently and audits the supplied reason.

### Authentication, API & configuration

- **Change password** — `POST /v1/auth/change-password` lets signed-in users change their password. Invalid current passwords return `auth.invalid_current_password`; weak passwords return `auth.weak_password`. Other sessions are revoked while the current session remains signed in.
- **Profile PIN attempt limits** — incorrect PIN responses include `attemptsRemaining`. Ten wrong PINs within 15 minutes trigger `profile.pin_locked` (`429`) with `retryAfterSeconds`; missing PINs do not count. The limit matches the existing switch-route budget.
- **Remove a profile PIN or avatar** — profile updates with `pin: null` remove the PIN and `avatarUrl: null` remove the avatar. Omitted fields remain unchanged.
- **Profile PIN status** — `GET /profiles/:id/pin` returns `{ hasPin }` to the profile's owner without exposing the PIN.
- **Copy profile preferences** — `POST /profiles/:id/preferences/copy` copies overrides from another profile belonging to the same account. `POST /profiles` also accepts `copyPreferencesFromProfileId`.
- **Hidden menu pages per profile** — `hiddenPages` stores comma-separated page IDs (`collections`, `discovery`, `insights`, `devices`, `remote`) and defaults to empty.
- **Unified list envelopes and search parameters (breaking)** — list responses consistently use `data` instead of `items`, `jobs` or `sessions` for Continue Watching, worker jobs, scan findings, downloads, playback sessions and live history. Admin list searches use `q` on users, logs and worker jobs. Clients using the old fields must be updated.
- **Stable validation error codes** — invalid cursors, unsupported cursor sorting, oversized/deep/too numerous fields and excessive filter values return specific `validation.*` codes with applicable limits in `params.max`.
- **Detailed error codes and parameters** — plugin manifest/interface validation, catalog and repository errors, streaming sessions and segments, task scheduling, image and sidecar processing, log files and media-tools checks return specific codes and parameters instead of generic categories.
- **Stable failure codes across subsystems** — download, media-scan, plugin-repository and update failures expose codes through `errorCode`, `probeErrorCode`, `decodeErrorCode`, `lastErrorCode`, `serverLastErrorCode` and `webLastErrorCode`. Clients should translate codes rather than raw exception messages.
- **Plugin archive validation** — `POST /admin/plugins/validate` checks an archive's manifest, entry point, interface manifest, minimum server version and whether installation would install, upgrade, downgrade or reinstall. It changes no installed state and creates no audit entry.
- **Plugin failure reporting** — plugin load failures expose `errorCode` alongside the raw error. Domain errors preserve their codes; invalid packages use `plugin.manifest_invalid`, and other load failures use `plugin.load_failed`.
- **Plugin registration limits** — plugins may register up to 64 HTTP routes, 32 jobs, 32 scheduled tasks and 128 metadata providers, subtitle providers or media analyzers. Exceeding a limit fails loading with `plugin.registration_limit.*`.
- **Built-in server settings** — new runtime settings include `stream.hlsMaxMuxingQueueSize` (512–8192), `downloads.maxConcurrentPerProfile` (1–5), `trickplay.maxFramesPerFile` (300–5000), `plugins.blobs.retentionDays` (1–365) and `plugins.notifications.maxPerDayPerPlugin` (0–1000, where `0` disables plugin notifications).
- **Additional scanning and worker timeouts** — `workers.definitions.libraryScan.timeoutMs` and `workers.definitions.downloadsProcess.timeoutMs` are configurable from one minute to one day (default two hours). `scanning.pathScanTimeoutMs` controls the per-path scan limit (10 seconds to one hour, default two minutes).
- **Additional stream settings** — `stream.seekDebounceMs` (0–2000 ms, default 300) controls seek debounce. `stream.hlsSegmentDurationSeconds` reports that a restart is required when changed.
- **Runtime monitoring configuration** — changing the resource monitoring interval or enabling/disabling monitoring re-arms the sampler immediately. Settings also report units and restart requirements where applicable.
- **Bounded watchlist status requests** — `GET /me/watchlist/statuses` rejects more than 500 titles per request with `watchlist.statuses_too_many` and caps query length. The library endpoint's `siblings` parameter is a boolean (`true`/`false`).
- **Subtitle and notification channel time limits** — external plugin notification channels are abandoned and logged after 15 seconds, allowing other channels to continue.
- **Database maintenance commands** — `bun run db:check` checks integrity, `bun run db:vacuum` vacuums the database, and `bun run db:backup [target.sqlite]` checks integrity before creating a consistent snapshot. Stop the server before running `db:vacuum`.
- **Startup diagnostics** — `bun run doctor` checks the Bun version, FFmpeg/ffprobe, data-directory writability, disk space, database integrity and migrations, and bundled web UI. It explains fixes and exits non-zero if a problem is found.
- **Log level and support bundle** — the runtime log-level setting can be changed without a restart, and `GET /admin/logs/bundle` provides a ZIP of server, rotated and FFmpeg logs.
- **Development configuration** — `bun dev` sets `NODE_ENV=development`, enabling pretty logs and development diagnostics without editing `.env`.
- **Plugin configuration export, import and reset** — admins can reset individual fields or all fields, export configuration without secrets and import configuration without overwriting secret fields. Uninstalling a plugin backs up its configuration; reinstalling the same plugin restores it.
- **Public plugin catalog diagnostics** — `GET /admin/plugins/catalog` reports repositories that could not be read, including error codes, separately from plugin results.

### Plugin administration & interface control

- **Plugin UI switches** — admins can hide a plugin's entire UI or individual pages, dialogs, tabs, slot entries, search providers or playback pre-roll without disabling the plugin. `GET/PUT/DELETE /v1/admin/plugins/:pluginId/ui` manages switches stored in `plugin_ui_overrides`; unknown keys are rejected, changes are audited and switches are removed on uninstall.
- **Stable plugin slot IDs** — `ui.json` slot entries can declare an ID unique within the slot. UI switches remain attached when other entries are reordered or removed. Duplicate IDs are rejected; entries without IDs keep action-derived keys.
- **Unreadable plugin configuration visibility** — admin plugin endpoints and dashboard responses expose `configReadError` (`plugin.config_unreadable`) when an existing `config.json` cannot be read.
- **Secret presence in plugin configuration** — `GET /admin/plugins/:pluginId/config` returns `hasValue` for secret fields without exposing their stored values.
- **Plugin package details** — admin endpoints expose plugin `capabilities`, `installedAt`, installer-managed `source`, `integrityOk` and `updateAvailable`.
- **Plugin upgrade rollback** — the previous package is retained until the new version loads. If loading fails during installation or enablement, the previous package is restored with configuration saved since the upgrade; the plugin returns to `state: rolled_back`.
- **Honest plugin install results** — catalog and upload installs report `previousVersion`, `direction`, `state` and failure details (`error` and `errorCode`) when the new version does not load.
- **Plugin interface switch cleanup** — after an upgrade, switches for contributions no longer declared by the plugin are removed. Plugins without an interface manifest keep their switches.
- **Plugin CSP control** — `PUT /admin/plugins/:id/csp` with `{ "enabled": false }` prevents an installed plugin's manifest from adding sources to the page's content security policy. The setting persists across restarts and upgrades and applies immediately.
- **Bulk plugin enable/disable** — `POST /admin/plugins/bulk` processes up to 100 plugins independently and reports each result.
- **Pin plugin versions** — `PUT /admin/plugins/:id/pin` with `{ "pinned": true }` prevents catalog updates from being offered for the installed version. Explicitly installing a newer version remains possible.
- **Plugin configuration validation** — required fields cannot be saved blank; unreadable configurations and failed reloads are logged. Broken plugin packages are listed as failed under their directory name instead of disappearing from the admin list.

## Fixes

### Library scanning & metadata

- **Filename year parsing** — years inside titles no longer override the actual release year; for example, `Blade Runner 2049 (2017).mkv` resolves to *Blade Runner 2049* (2017). Year-first formats such as `(1993) Jurassic Park` and `1993 - Jurassic Park` are also recognized correctly.
- **Provider ID tags and edition matching** — `[tmdbid-…]`, `{imdb-…}` and `[tvdbid-…]` tags are removed from parsed titles, and `Uncut` is ignored when matching edition names.
- **Rematch preserves locked metadata** — re-identifying a title no longer overwrites administrator-locked fields, including artwork, cast and genres, unless `overwriteLocked` is set.
- **Library metadata language respected** — title refresh, artwork refresh and provider reassignment now use the metadata language configured for the library.
- **Missing episode overviews** — when a season payload omits an episode overview, the importer requests that episode individually and uses its overview when available.
- **Scan results report removed files** — scan results now include the number of files actually removed. Removals skipped by the mass-removal guard or unreliable storage are excluded; `analyzedFiles` remains `0` because scanning performs a diff and analysis occurs in ingest jobs.
- **Scans take priority over bulk jobs** — library scans are enqueued with higher priority than bulk background work instead of waiting behind every pending ingest or refresh job.
- **Provider cache correctness and bounds** — metadata lookup cache keys now include the library's metadata language and provider order. Per-library provider overrides are capped at 200 entries, and changing `plugins.providers.detailsCacheTtlMs` rebuilds provider result caches without a restart.
- **Stale catalog IDs return 404** — watchlist additions, ratings and watched-state syncs involving deleted catalog entities now return `404 entity.not_found` with the relevant metadata or media-file ID.
- **Repeated watched actions are idempotent** — marking an already watched file again no longer creates duplicate history entries or inflates analytics. Manually marking an episode fully watched also completes its progress, allowing Continue Watching to advance to the next episode.
- **"Not interested" titles are excluded** — titles rated `0` no longer appear in Discover recommendations or Trending.

### Cache invalidation & data consistency

- **Catalog caches update after metadata changes** — artwork changes, title creation/deletion/merge, orphan purges, refreshes and scans now invalidate affected catalog caches, including people, companies, genres, keywords and collections.
- **Catalog entity edits invalidate lists** — creating, editing, deleting, reordering or refreshing genres, companies, keywords, people, episodes and collections now clears affected cached list responses.
- **Notification lists update immediately** — creating notifications clears the recipient's cached list alongside the unread badge, including batched new-episode notifications.
- **Discover and insights reflect completed playback** — finishing a movie or episode invalidates the profile's cached Discover view and insights.
- **Avatar changes invalidate cache after commit** — profile cache invalidation now occurs after the avatar transaction commits, preventing the previous avatar from being served for several seconds.
- **Profile default changes invalidate effective preferences** — saving or resetting `profiles.defaultPreferences.*` flushes cached responses that include effective preferences.
- **Settings audit records actual values** — the audit trail now stores saved settings correctly instead of recording an empty `{}` as the "after" state.

### Authentication, API & error handling

- **Admin leaderboard dates** — last-played timestamps are now interpreted as epoch seconds rather than milliseconds, eliminating dates in 1970.
- **Dashboard works without a log file** — missing log files are treated as empty logs instead of causing `500` responses on the dashboard or log list.
- **Blocked accounts lose API-key access** — API keys are rejected while their owner is blocked; timed blocks end when their expiry passes.
- **Anonymous session revocation** — `DELETE /v1/auth/sessions` returns `401` rather than `500` when no session is present.
- **Log deletion errors** — deleting a missing log file returns `404`. Attempts to target the logs directory itself or include a NUL byte are rejected as invalid input.
- **Unsafe plugin archive paths** — plugin archives containing NUL bytes in member names are rejected as unsafe paths instead of producing raw filesystem errors.
- **Fresh installation startup** — the wildcard-host constant is initialized before the boot check, preventing reference errors before setup has completed.
- **Server-side response validation** — responses that violate their own schema now return a logged `500 internal`, not `400 validation.invalid_request`. Invalid request input continues to return `400`.
- **Stable authentication error codes** — registration, login, setup and admin user-action failures now use stable codes such as `auth.email_registered`, `auth.weak_password`, `auth.invalid_email`, `auth.user_banned`, `auth.invalid_credentials` and `auth.request_rejected` instead of leaking raw Better Auth messages.
- **Download error codes and status codes** — disabled downloads return `403 downloads.disabled`; duplicate and quota-exceeded requests return `409 downloads.in_progress` and `409 downloads.quota_exceeded` with quota parameters. Additional errors include `downloads.media_file_required` and `downloads.duration_unknown`. Internal insert failures now return `500 internal`.
- **Consistent stream limits and throttling** — server-wide and per-user stream limits return `429 stream.limit_reached` with scope, limit and retry information. Rapid session starts return `429 stream.creation_throttled`, and applicable `429` responses include `Retry-After`, exposed through CORS. Missing active profiles consistently return `401 auth.profile_required`.
- **Stream errors carry actionable codes** — missing segments, rebuilding playlists and sessions not ready return `stream.segment_not_found`, `stream.segment_not_ready`, `stream.playlist_rebuilding` and `stream.not_ready`. Stream-limit errors include the active-session count.
- **API reference corrections** — OpenAPI documentation now includes missing admin-only `403` responses, response schemas and descriptions for admin downloads, two-factor authentication and playback heartbeat, corrected worker trigger documentation, and complete admin-module and event-stream tags.
- **List-query validation** — invalid cursors, unsupported cursor sorting and field/filter limits return specific `validation.*` codes with applicable maximum values.

### Plugin lifecycle & configuration

- **Disabled plugins no longer serve UI assets** — the plugin UI asset endpoint returns `404 plugin.not_found` unless the plugin is enabled.
- **Upgrades preserve disabled state** — upgrading or reinstalling a disabled plugin no longer re-enables it.
- **Plugin rate limits are isolated** — each plugin now has its own per-profile rate-limit bucket instead of sharing one across all plugin routes.
- **Notification channel failures are visible** — administrators receive a notification when an external channel starts failing, with repeated failures suppressed until delivery succeeds again.
- **Required plugin fields cannot be saved blank** — configuration updates reject empty required fields with `plugin.config_invalid` and identify the field. Existing stored values count as set.
- **Plugin configuration errors are no longer silent** — unreadable configuration files and failed reloads after saving are logged; broken plugin packages appear as failed entries until fixed.
- **Plugin settings report validation errors** — invalid setting values include allowed `min`/`max` bounds through `admin.settings.invalid_value`; unknown keys return `admin.settings.unknown_key` instead of being silently dropped.
- **Plugin and repository errors are more specific** — archive checks and plugin repository operations report stable codes and parameters for the exact failing check rather than generic error categories.

### Streaming & FFmpeg

- **HLS segment duration is stable during playback** — running sessions no longer read a changed segment-duration setting while their FFmpeg process uses the old grid. Changes apply after a server restart.
- **Playback diagnostics use the active encoder** — each session captures its encoder environment at creation, so later changes to hardware acceleration or tone-mapping settings do not misreport the running stream.
- **HDR transcode reasons are accurate** — diagnostics no longer claim that HDR was tone-mapped when no tone-mapping filter was available; the response reports `toneMapped: false`.
- **Start-up FFmpeg and environment errors are clearer** — invalid environment values produce one line per variable with a fix hint, occupied ports identify `APP_PORT`, and `.env.example` uses the default port `3030` for `APP_PUBLIC_URL`.
- **Configuration warnings at startup** — malformed allowed-origin entries and FFmpeg versions older than the recommended 6.x release are reported as warnings.
- **Development mode uses development settings** — `bun dev` now sets `NODE_ENV=development`, enabling pretty logs and dev-only diagnostics. The development default bind is `0.0.0.0`; pending setup without a setup token produces a network-access warning.
- **Unwritable data directories fail clearly** — an invalid or unwritable `ROOT_DIR` reports the path, cause and remediation, then exits instead of throwing a low-level filesystem error.
- **Password sign-in attempts reset after success** — failed password attempts no longer remain counted against the per-account limit after a successful login.
- **Deleting the active profile clears its cookies** — `current_profile_id` and PIN-unlock cookies are cleared when the profile currently in use is deleted.
- **Profile bootstrap without an active profile** — `GET /me` now requires only a session and returns `profile: null`, allowing the profile picker to load. Other `/me` routes still require an active profile.
- **Settings accept empty values when the default is empty** — `ffmpeg.hwaccelDevice`, `plugins.http.allowedDomains` and empty profile-language defaults now accept `""`; settings with non-empty defaults still reject empty input.
- **Default-valued settings no longer create overrides** — saving a value equal to its definition default removes the stored override, preserving environment fallbacks such as `APP_FFMPEG_PATH`.
- **Watcher settings re-arm timers immediately** — changes to `scanning.watcherFallbackIntervalMinutes` or `scanning.scheduledScanIntervalHours` take effect without waiting for a restart.
- **Image upload size follows its setting** — artwork uploads are no longer hard-capped at 20 MB when `images.maxUploadBytes` is higher. The configured limit is enforced with `images.upload_too_large`.
- **Orphaned subtitle renditions are cleaned up** — a daily cleanup removes extracted `.vtt` files without subtitle records, using a 10-minute grace period for in-flight extractions.
- **Orphaned download files are removed** — the daily download sweep removes artifact directories whose download rows no longer exist, while leaving directories not named after a download ID untouched.
- **API-key throttle no longer delays shutdown** — the last-used throttle timer is unreferenced so it cannot keep the process alive.

### Database, updates & operations

- **Failed database backups report a specific code** — unsuccessful backups return `database.backup_failed` with the backup process exit status; detailed diagnostics remain in server logs.
- **Update failures and rollback are recorded** — failed installs and rollbacks, exhausted worker retries, and disk/memory pressure now create persisted administrator notifications, deduplicated per failure over six hours.
- **Collection membership survives title merges** — merging title versions transfers source collection memberships to the target without duplicating an existing target entry.
- **Admin user creation returns the correct status** — creating a user now returns `201 Created`, and list pages below page 1 are clamped to the first page.
- **Clearer setting feedback** — settings validation reports range limits and unknown keys instead of silently dropping invalid changes.
- **Worker and scan timing is configurable** — library-scan, download-processing and per-path scan timeouts can be adjusted through their respective settings, with changes applying to newly started work.
- **Database maintenance is safer** — backup creation checks database integrity before writing a snapshot, and restore creates a recoverable copy before replacing the database.

### Analytics & reporting

- **Interrupted playback counts in admin analytics** — sessions ending before a title finishes count toward plays, watch time, leaderboards, top titles and recent plays after `system.analytics.minPlaySeconds` (default 60 seconds, range 0–3600). `completedPlaysCount` distinguishes finished plays from `totalPlaysCount`. Watch history and insights remain unchanged; interrupted sessions follow watched-history retention settings.
- **Failed operations are visible to administrators** — important worker, update and resource-pressure failures persist as notifications instead of being broadcast only to connected dashboards.
- **Log truncation is reported** — admin log responses identify when only the last 2 MiB are served, enabling the viewer to communicate that search and pagination cover a limited window.
- **Watch-state and recommendations remain consistent** — repeated watched actions no longer inflate history, completed episodes advance Continue Watching, and titles marked "not interested" are excluded from recommendations and Trending.

### Compatibility notes
- **List response fields changed** — clients must migrate from `items`, `jobs` and `sessions` to `data` for the affected endpoints. Admin search parameters on users, logs and worker jobs now use `q`.
- **Existing profile databases** — new profile preferences such as `hdrMode`, `hideRatingOverlay`, `resumeRewindSeconds`, `watchlistAutoRemoveWatched`, `mutedNotificationTypes` and `hiddenPages` use the existing preference storage unless a specific migration is noted above.

# v1.3.1

### Fixes

- **Log file memory grew under request load** — the file stream wrote one chunk per log line, so queued lines piled up in memory faster than they drained. Each queued batch is now one write.
- **Seasons and episodes stay in season order** — the per-show season and episode reads had no `ORDER BY`. Before planner statistics exist, SQLite walks an index that happens to give season order; after `ANALYZE` it can return insertion order, so Season 3 could list before Season 1. Both reads now sort by season number, and episodes by episode number within it.
- **Collections need the full `minItems` count** — the threshold check matched any collection with at least one title, so with the default of two, single-title collections were counted and listed. A collection now needs `minItems` titles, in both the count and the page.
- **Movie smart-play resumes the file watched last** — with several files, smart-play read the first progress row, which had no defined order, so it could start a fresh play on a finished file instead of resuming the half-watched one. Progress rows are now read newest first.
- **Quick-connect pending entries are capped at 1,000** — the 15-minute TTL alone let a burst of pairing requests grow the pending maps. The oldest entry is evicted at the cap.

### Performance

- **The response cache budgets bytes, not entries** — with the old 512-entry cap, cache-on browsing was no faster than cache-off (1,707 vs 1,711 req/s at c=50). Each body is charged by length against 2 MiB per GiB of RAM (32–256 MiB), with an 8,192-entry bound.
- **Cache hits write their headers once, and Accept-Encoding results are memoized** — a hit set Cache-Control, Vary and ETag twice. Negotiation results are kept in a bounded 64-entry LRU.
- **Elysia's response transform encoding is off** — SDK `t.Date()` fields made Elysia run its transform over every uncached response. `JSON.stringify` writes the same ISO timestamps, and the compiled response check still runs. One change: a number in a timestamp field is now served as a number instead of failing response validation with a 422.
- **Metadata relations are prepared, and detail loads in one statement** — the detail page ran ten relation queries; it now runs one prepared statement. `metadataRepository.findById` went from 11 to 2 statements, and list and detail order their arrays the same way.
- **The scan findings page counts inside the findings query** — `librariesService.getScanFindings` went from 3 to 2 statements.
- **Collections use the junction index** — listing collections joined and grouped the whole junction table. It now probes the index and counts with `COUNT(*)`.
- **Collection lists reuse poster previews** — each list page re-read the member count and up to four posters for every collection, and the poster query scanned every member title. Previews are cached per collection (1,024 entries, 10 s TTL) and dropped by the writes that flush list bodies; reads inside a transaction bypass the cache. A write that does not flush list bodies can leave previews stale for up to 10 s, the same bound as list totals.
- **Title search probes a trigram index before its fallback scan** — a term with no match scanned the whole catalog, because a leading-wildcard `LIKE` cannot use an index. An FTS5 trigram table answers an empty probe without scanning; matches still pass the `LIKE` check, so results are unchanged.
- **Media-file, playback and primary-key reads are prepared** — these reads rebuilt Drizzle query builders on every call. They now use prepared statements, with id lists passed through `json_each`. The media-files and collections rows include some of this work; playback reads have no separate measurement in this release.
- **Logs and static files do less per request** — log lines are written as one buffer per 2 ms window, and access lines skip pino's per-line sanitizer. Rate-limit overrides parse once per settings revision, and the web root and static files are stat'ed once.
- **Heavy packages load on first use** — libvips loads with the first image operation, and the XML sidecar, zip and plugin packages load when used. The `uuid` dependency is removed; provider person ids keep their values.

### Performance benchmarks

Seeded catalog of 5,000 rows on one machine, managed server. Each value is the median of three rounds run in alternating order (the code before this release, then this release); the machine was quiet (1-minute load below 2) before each run. Rows marked "cache off" use `--no-cache`. Within-side spread is within ±5% except collections at c=100 (base 1,556–1,810 req/s, this release 3,867–5,622 req/s).

| Area | Benchmark | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| HTTP | `GET /v1/metadata?limit=24` catalog browse, cache on, c=50 — req/s | 1,707 | 30,078 | **+1,662%** |
| HTTP | Same, cache on, c=50 — p95 | 44.1 ms | 2.7 ms | **−93.9%** |
| HTTP | Same, cache off, c=50 — req/s | 1,711 | 2,422 | **+41.6%** |
| HTTP | Same, cache off, c=50 — p95 | 43.5 ms | 30.9 ms | **−28.9%** |
| HTTP | `GET /v1/metadata?limit=24` catalog browse, cache off, c=50, `encodeSchema` alone — req/s | 1,974 | 2,457 | **+24.4%** |
| HTTP | Same, c=50, `encodeSchema` alone — p95 | 37.3 ms | 30.0 ms | **−19.4%** |
| HTTP | `GET /v1/media-files?limit=24`, cache off, c=50 — req/s | 1,888 | 3,778 | **+100.1%** |
| HTTP | `GET /v1/collections?limit=24`, cache off, c=50 — req/s | 951 | 1,916 | **+101.4%** |
| HTTP | Same, c=100 — req/s | 1,645 | 4,981 | **+202.8%** |
| HTTP | `GET /v1/collections?limit=24`, cache off, c=1, poster-preview change alone — req/s | 480 | 2,757 | **+474%** |
| HTTP | Same, c=1 — p95 | 2.80 ms | 0.60 ms | **−78.6%** |
| HTTP | `GET /v1/metadata/:id` movie detail, cache off, c=10 — req/s | 11,758 | 18,564 | **+57.9%** |
| HTTP | `GET /v1/metadata/search/global?q=zzzq` (no-match fallback), cache off, c=50 — req/s | 1,125 | 5,167 | **+359.2%** |
| HTTP | Same, c=50 — p95 | 49.0 ms | 11.1 ms | **−77.3%** |
| Static | `GET /` SPA entry, c=50 — req/s | 36,217 | 55,020 | **+51.9%** |
| Static | `/assets/app.js` (64 KiB), c=50 — req/s | 16,158 | 25,820 | **+59.8%** |
| Static | `/assets/app.js` range `bytes=0-4095`, c=50 — req/s | 17,142 | 30,170 | **+76.0%** |
| In-process | Cache hit through `app.handle`, browser `Accept-Encoding`, c=1 — req/s | 225,939 | 248,490 | **+10.0%** |
| In-process | Same, c=50 — req/s | 197,085 | 224,645 | **+14.0%** |

The browse and collections rows are the combined result of every change above; they do not isolate one change. The `encodeSchema` rows isolate that one change: the same build with only the option flipped, three alternating rounds per side. The poster-preview rows isolate that change: the tree before it, then with it, three alternating rounds per side. They ran at a 1-minute load of 8–9 from other processes, so their absolute numbers sit below the rows above.

### Additional measurements

- Idle RSS 154.4 → 141.1 MB (−8.6%) and peak RSS 179.0 → 163.1 MB (−8.9%): median of nine boots per side, alternating in blocks of three. Boot time (spawn to health) 544 → 529 ms, with overlapping ranges, so no measurable change.
- Query-count audit: all 19 audited operations are within budget.
- Responses: `/openapi/json` is byte-identical to the previous release. Of 34 probed HTTP endpoints, 32 return the same status and body; the other two (`/v1/health` and `/v1/admin/dashboard`) report live memory figures, which also change between runs of this release.
- Season and episode order adds no measurable cost: the per-show episode read goes 13.1 → 13.3 µs for 50 episodes and the season read stays at 1.3 µs (in-process, after `ANALYZE`). The planner walks the season and episode index in order, so no temp sort is added.
- Playback progress read with the newest-first order: 1.30 → 1.63 µs per call (+0.33 µs, in-process). The planner adds a temp sort over the title's progress rows; kept because resume depends on it.
- Collection threshold probe `LIMIT 1 OFFSET minItems − 1`: 0.58 → 0.61 ms at the default `minItems` of 2 (+5%), and 0.58 → 0.64 ms at 3, for a 2,000-collection catalog with 12 titles each (in-process). The probe reads up to `minItems` junction rows per collection instead of one.
- Collection poster previews, in-process (`findPage` limit 24, 5 collections, 5,000 titles): a cached read with a distinct poster per title goes 9,558–9,659 → 85–106 µs; with the shared-poster seed, 1,522–1,719 → 74–88 µs. A read after a flush keeps the uncached path: with distinct posters, the median across six alternating rounds is 9,522 → 9,675 µs (+1.6%, within host noise).

# v1.3.2

### Fixes

- **`GET /v1/media-files/audit` could be triggered cross-site** — the state-changing GET now refuses `Sec-Fetch-Site: cross-site`.
- **`pinned` and `cspDisabled` choices could be reverted by a concurrent install** — both now run under the lifecycle lock.
- **`pluginRepositories.count()` returned 0 or 1** — it used a `LIMIT 1` probe; it is a real count now.
- **A blank log file id can no longer truncate the active log** — `DELETE /v1/admin/logs?fileId=<whitespace>` answered 200 and emptied `reelvault.log`, because a blank id was treated as no id and resolved to the active log. Only a missing id now means the active log; a blank id is refused with `admin.log_path_invalid`, on download too.
- **A database restore restarts the server** — restoring a backup closed the database but left the server process running, so the server kept serving against a closed database. The restore helper waits for the process to exit before it swaps the database file, so it never ran. The restore now asks the server to shut down gracefully, the helper swaps the database, and the server starts again on the restored data.
- **A failed library provider-override write could wipe all overrides** — the delete and insert ran outside a transaction, and duplicate provider ids raised on the primary key after the delete had committed; the replace is now one transaction over de-duplicated ids.
- **A failed repository token read reports its own cause** — a stored repository token in an unsupported payload format raised a plain error, so the repository's last error showed the generic unavailable code. The token read now fails with `secret.unsupported_payload`, and that code is what the repository records as its last error.
- **A failed server component swap could leave the install root without `server/`** — a partial swap now restores the moved entries.
- **A failed upgrade rolled back to a disabled version is listed once** — enabling an upgrade whose new version did not load restored the version it replaced. When that version was disabled, the plugin list also kept a failed entry for the new build beside it. The failed entry is now cleared on rollback, so the plugin is listed once, as disabled at the restored version.
- **A failing notification channel can no longer leave an unhandled rejection** — when a channel stopped delivering, the administrator report was dispatched without a catch, so a failed report (for example a database error while writing it) became an unhandled promise rejection. The report failure is now logged as a warning with the channel id.
- **A failing shutdown step no longer leaves the database open** — shutdown stopped at the first error, so a single failing service skipped every later step, including closing the database and flushing the logs. Each step now runs on its own; failures are logged with the step name and the process exits with code 1 at the end.
- **A finished title always gets its watched-history row** — finishing a file wrote the progress row and then the watched-history row in two separate statements. If the second write failed, the progress stayed marked completed, and every later update skipped the history write because the file already looked completed, so that play never reached watched history. Both rows are now written in one transaction: a failed history write rolls the progress back, and the retry records the play.
- **A force-released handler could stretch the timeout of a newer attempt** — `extendTimeout` is bound to its own execution now.
- **A keyframe probe could return a keyframe after the requested position** — the cache is keyed by the exact target instead of a 2 s bucket.
- **A malformed session cookie answered 500** — `decodeURIComponent` threw on an invalid percent escape inside the auth derive; a cookie that cannot be decoded now reads as "no session".
- **A plugin whose lockfile record survived a deleted directory could never be reinstalled** (`plugin.already_installed`), and manually dropped plugin directories could never be uninstalled through the API; both paths work now.
- **A process that never reaps after SIGKILL held its caller forever** — FFmpeg and FFprobe waits are bounded and fail with `ffmpeg.kill_timeout` instead of holding a semaphore slot (stalled network mounts).
- **A release racing a seek could leak a session reservation** — `prepareSession` re-reserved the slot after the stop await without checking the session still existed, so a release in that window left a ghost reservation that blocked playback until restart; the re-check now skips a released session.
- **A repeated Ctrl+C or SIGTERM forces exit** — a second signal during a graceful shutdown was only logged, so the process ran on until the shutdown timeout.
- **A resumed operation could stay pending forever** — the pre-set total counted every cancelled row, but rows skipped because their worker no longer exists or their dedupe key is active never became jobs, so the finished count could never reach the total; resume now rebuilds the counters from the rows that were actually re-enqueued (including on a failed re-enqueue). The resume no longer leaves `pending: 0` for a fully queued operation.
- **A second external subtitle in the same language reported "not found" and deleted the uploaded file** — the fallback looked up the source path while the unique index keys on `(mediaFileId, language, type)`; a duplicate language now reuses the existing row.
- **A second file for an episode already imported no longer aborts an offline rebuild** — two videos naming the same season and episode (`S02E01.mkv` and `extras/S02E01.mkv`) failed the episode insert on its unique key, so the whole offline catalog rebuild stopped with a raw database error. The first file is imported; the second is listed as skipped with a reason.
- **A seek answered "buffered" while a restart was wiping that buffer** — the buffered check runs under the same session lock as restarts.
- **A worker finalize failure could become an unhandled rejection** — the execution promise was never observed outside `drain()`; the pool now logs finalize failures instead of leaving an unhandled rejection behind.
- **Aborting a probe released the ffprobe concurrency slot while the shared probe kept running** — the budget now lives inside the cached probe, so it bounds actual probe processes.
- **Adding a second file for an already-imported episode sent "new episode" notifications again** — notifications are only sent when the episode row is actually created.
- **An exit from a replaced FFmpeg process could close a newer operation** — the exit handler now compares the process handle.
- **Attached pictures, font attachments and data tracks were imported as embedded subtitles** — anything that was not a usable video or audio stream fell into the subtitle branch, so MKV cover art and embedded fonts produced permanent broken subtitle entries; only `codec_type = subtitle` streams are stored now.
- **Bulk "mark as watched" did nothing for files without a known duration** — the progress row stayed incomplete with a bogus position; the explicit intent is honored now.
- **Cancelling a diamond-shaped dependency set over-counted an operation** — a dependent reachable from two levels was counted twice, so progress could exceed 100%; ids are de-duplicated before the counters.
- **Cancelling an operation could still start its pending jobs** — the cancel request and the claim are separate statements, so the poller could claim rows in between; pending rows are cancelled before the running ones and a claim now skips jobs of a cancelled operation.
- **Capacity errors reported `active: 0`** — the server-limit explanation counted only reserved ids instead of attached plus reserved sessions.
- **Container CPU comes from the container's own cgroup counter** — the first cgroup reading was never recorded as a baseline, so the cgroup path never activated and container CPU always fell back to the host-wide `/proc/stat` figure. On a busy host, a container that was idle looked pegged. The first reading now sets the baseline, and CPU is computed from the second reading onward.
- **Creating a title that already exists under a case/Unicode variant answered 500** — the generic find-or-create re-read by the raw `(title, type, releaseDate)` while the unique index keys on the normalized stable key, so the duplicate insert was swallowed and the fallback found nothing; it now re-reads by the stable key. A provider update that would collide with such a duplicate now merges it instead of aborting the transaction.
- **Diagnostics reported the hardware encoder after a software fallback** — `forceSoftware` was ignored when naming the encoder.
- **Dot-segment request paths bypassed rate-limit exemptions and the public-GET classification** — the pathname is normalized (decoded `.`/`..` collapsed) before classification, matching what the router resolves.
- **Download retention sweeps stop before the database closes** — the sweep timers were never cleared, so a sweep could run against a closed database during shutdown. Shutdown now stops them first.
- **Editing a subtitle could serve stale cues** — an in-flight extraction is awaited before the VTT is dropped, and the info cache is invalidated after the write instead of before it.
- **Enabling or disabling a plugin silently ignored lockfile failures** — only the `plugin.not_installed` case is swallowed now; read and write errors surface.
- **Episode numbers of up to four digits are read in full** — `Show.S01E100.mkv` was read as episode 10 because episode numbers were capped at two digits, so long-running series imported their 100+ episodes under the wrong number. Episodes now read up to four digits (`S01E1000`, `One.Piece.E1000`, `One Piece - 1000`). A bare year such as `Blade.Runner.2049` is still not an episode, and a five-digit number is no longer cut to its first four digits.
- **Internal failures in the database, FFmpeg, workers and the memory cache carry codes** — invariant checks in these areas threw plain `Error`s, which reached clients as the generic `internal` code. They now throw `DomainError` in the `internal` category with specific codes (for example `ffmpeg.start_failed`, `table_access.primary_key_missing`). The HTTP status stays 500.
- **Internal invariant failures carry codes** — the concurrency check in `PromiseUtils.mapConcurrent`, the sort-column guard in `QuerySorting`, and the unknown system-setting key lookup threw plain errors. They now throw `DomainError` in the `internal` category with the codes `concurrency.invalid`, `query.sort_column_missing` and `settings.unknown_key`. The HTTP status and behavior are unchanged; only the code differs.
- **Offset pages on second-resolution timestamps could repeat or skip rows** — title recommendations, media markers, admin users and admin sessions now append the id as the `ORDER BY` tiebreaker.
- **Path parameters are validated from one shared schema** — several admin routes declared their `:id`, `:jobId` and `:providerId` params inline with `minLength: 1`, while the shared schemas used everywhere else omitted it, so the same request was refused by validation on one route and reached the handler on another. The shared route-param schemas now carry the rule (provider ids cap at 128), the inline copies are gone, and `GET /v1/libraries/:id` uses the shared `fields` schema with its 2048-character cap instead of an uncapped copy.
- **Per-profile aggregation bodies are keyed by the calling credentials** — `GET /v1/metadata/:id/details-view` and `GET /v1/playback-sessions/view/:mediaFileId` cached their bodies under a caller-supplied key ending in `anon` when no profile was selected, so every such session shared one cached entry. Both now build the same credential-scoped key as every other cached route (cookie, profile id, API key), and per-profile invalidation drops them through the shared profile index instead of a separate key scan.
- **Re-running a worker from the admin panel could leave a phantom `pending` operation** — a dedupe race left the freshly created operation behind; the manual run now drops it like the other enqueue paths.
- **Releasing a session left playlist waits polling a deleted directory** — release now fails them immediately, and a released session cannot leave a stale cushion entry.
- **Seeks cancelled during shutdown carry a specific code** — seeks still waiting when the streaming system shut down failed with an unclassified error, so clients received the generic `internal` code. They now fail with `stream.seek_cancelled`; the HTTP status stays 500.
- **Server rescue never armed after being enabled at runtime** — the monitor latched `system.rescue.enabled` at boot; changing the setting now arms or disarms it immediately.
- **Sidecar scans and offline rebuilds recognize the same episode file names as a normal scan** — both matched `SxxExx` with a reduced pattern instead of the shared episode parser, so `Show 1x05.mkv` (or `S01E1000`) was imported by a normal scan but skipped by an offline catalog rebuild, and sidecar scans left those files without an episode number. Both now call `extractSeasonEpisode`, the parser online recognition uses.
- **Single-file and single-title DELETE ignored active streams** — only the bulk endpoints checked for playing sessions, so deleting one file or title ended its playback; both single-delete paths now return the same conflict, and bulk `force` behaves as before.
- **Software transcodes kept the source height** — the libx264 scale filter's height cap divided the width cap by the output height instead of the source aspect ratio (`min(W/H, H)` collapses to a constant), so every downscaled CPU transcode (and the software-fallback retry) produced distorted output with roughly twice the pixels (4K→1080p came out 1920×2160). The cap now uses `min(widthCap / a, heightCap)`.
- **Startup failures are logged before the process exits** — the "Failed to start server" line and the port-in-use message were buffered in the same way and lost when the process exited right after them.
- **State-changing quick-connect, two-factor and setup requests skipped the Origin check** — the hook was registered after the quick-connect child plugin (hooks only cover routes registered after them), and the two-factor and setup routes never had the check; all three now run the shared guard before their routes.
- **Static assets share one extension→MIME table** — the web bundle and plugin UI bundles kept separate tables that disagreed: the same `.js`/`.mjs` file was served as `text/javascript` from the web app and `application/javascript` from a plugin, and only one table knew `.ttf`/`.vtt`. Both now use one table in `utils/mime.utils.ts` (`text/javascript; charset=utf-8`); plugin UI keeps its own servable-extension allowlist, so `config.json` is still never servable.
- **Streaming sessions close gracefully on SIGINT and SIGTERM** — the FFmpeg process tracker killed every FFmpeg process as soon as the signal arrived, which cut sessions off before their graceful close. Shutdown now handles signals alone; the process-exit hook remains as a last resort. The same listener also swallowed a SIGTERM sent during startup, so the process kept booting; it now stops at once.
- **Successful responses report the route's rate-limit budget** — the global budget overwrote the route's `X-RateLimit-Limit`, `Remaining` and `Reset` headers on every successful response, so a route with a budget of 10 advertised 1000. Only 429 responses showed the route's budget. Routes with their own budget keep it; routes without one still report the global budget.
- **The HLS GOP was clamped to 60 frames for every source** — the assumed 24 fps was divided by the segment duration, making the clamp 4–10 fps; the GOP now scales from the 24 fps assumption (144 frames for a 6 s segment at 24 fps, 360 at 60 fps).
- **The last log lines of a shutdown are written** — log lines are batched for a 2 ms flush window, and shutdown called `process.exit` before that window closed. The closing lines, including "Graceful shutdown completed" and shutdown errors, never reached the log files. Shutdown now drains the log buffers before it exits.
- **Unloading a plugin could unregister core workers** — teardown unregistered the plugin's raw job names (`refresh`, not `pluginId:refresh`) against the global worker registry, so a plugin job named like a built-in worker (e.g. `metadata-refresh`) removed that worker and cancelled its queued jobs; scopes now track and unregister only their namespaced ids.
- **Windows libraries never removed stale rows** — `filterPathsWithinRoots` built its root prefixes with `/` while Windows resolves paths with `\`, so no path ever matched, the mass-removal guard never ran, and deleted files kept their database rows; both sides are normalized now.

### Performance

- **`COUNT(*) OVER ()` count merges were measured and rejected** — a window count wins only where the count itself is expensive (0.92 vs 1.49 ms on a filtered scan) and loses ~2.2× on plain pages (0.65–0.78 vs 1.42–1.77 ms), so the page and the cached count stay separate statements.
- **A collection page no longer re-reads its rows** — the qualifying page query returned ids and the repository then loaded the same rows again with `inArray`; the page query now returns the rows it already ordered and limited, and they hydrate directly. `collectionRepository.findPage` 6 → 5 statements with a cold count (3 → 2 with a warm count cache), 2.14 → 1.99 ms in the same suite, inside the run-to-run spread.
- **A collection page reads its preview counts and posters in one statement** — both halves of a preview scan the same 24 collections, so they now run as one `UNION ALL` (poster rows first, split on a discriminator). Measured neutral against the two parallel reads (7.8 ms p50 on five 1,000-title collections with posters, identical payloads), `collectionRepository.findPage` went 5 → 4 statements with a cold count (warm count cache unchanged at 2).
- **A playback session starts with one read instead of three** — `selectPlayback` read the file bundle, the profile preferences and the saved progress row, then (conditionally) the title-level resume check and the title's stream preferences: 4–5 statements in up to three sequential phases. `mediaRepository.findPlaybackSessionData` now returns the file row with its stream/subtitle relations, the progress row, a title `EXISTS` and the per-title preferences as JSON columns of one statement; the profile preferences (cached in production) stay separate and supply the resume threshold. A session start went 4–5 → 2 statements on a cold preferences cache (3–4 → 1 with warm preferences); probe p50 0.049 → 0.021 ms resuming, 0.057 → 0.019 ms fresh and 0.073 → 0.020 ms when another version of the title is in progress, with identical file, progress, title-check and preferences payloads. The old title-check reader and the streaming port's progress/preferences reads are gone; `findForPlaybackSession` stays for the plugin capability.
- **Bun's compiled-statement cache is sized for the dynamic SQL the query layer builds** — `Database.MAX_QUERY_CACHE_SIZE` raised from Bun's default of 20 to 512 before the first connection opens: a 48-distinct-shape sweep went 0.11 → 0.03 ms p50, while the single-statement control stayed at 0.01–0.02 ms (`database` suite, "compiled-statement working set").
- **Chunked id readers bound 2,000 variables** — `queryChunkSize` raised from 500, cutting the statement count on large id lists: a 5,000-title relation batch went 30 → 9 statements (8.93 → 7.97 ms).
- **Continue-watching reads its four dependent arrays in one statement** — the title rows, media files, regular seasons/episodes and backdrops behind the page are all keyed by the same metadata id list, so they come back as JSON columns of one statement instead of four parallel round trips: `playbackRepository.findContinueWatchingData` 5 → 2 statements, the full path 0.14–0.15 vs 0.16 ms p50 in the probe (24 titles, 46 media files, 24 episodes, 2 backdrops, all four arrays byte-identical after revival). The seasons/episodes scope builder is shared with the playback overview, so the standalone seasons reader is gone.
- **NDJSON marker imports write in one pass** — the import checked every named file with its own `isExists` read and then replaced each file's markers one at a time (existence check, before-snapshot, delete, insert and audit). It now checks all ids in one chunked read and replaces every file's markers in one pass (one before-snapshot read, one scoped delete, one insert per chunk) while keeping one audit entry per file; the parser still rejects an invalid line before the first write. A 50-file import went 300 → 5 statements (30.4 → 3.3 ms), with identical marker rows.
- **Bulk "mark watched" writes in one transaction** — the endpoint accepts up to 500 media files but ran the single-file update per id: one progress read, one upsert, one history insert and a title-completion check each. The watched path now reads the files and the profile's saved progress in one statement, writes every progress row and the play rows in one transaction (a file's saved audio track and subtitle are kept, already-watched files add no play), publishes the same per-file events, checks each affected title once and invalidates the profile's recommendation caches once: a 40-file batch went 121 → 4 statements (one read, one upsert, one history insert, one preferences read), with identical progress and history rows. The unwatched path keeps its single delete.
- **Discover reads both "recently added" lists together** — the home view ranked movies and shows with two separate calls and hydrated each list on its own (two row reads and two three-statement relation loads). `metadataRepository.findRecentlyAddedByTypes` ranks each type with its own `LIMIT` and order, then reads the rows and relations once for the union of the ids: the two lists went 10 → 6 statements (two ranks, one row read, three relation loads) with identical order and payload (probe: 50 movies + 1 show, byte-identical; 2.67 → 2.62 ms, inside the run-to-run spread).
- **Large relation batches skip the chunk loop** — `loadRelations` recursed on 2,000-id chunks although the batched reader binds the whole id list as one JSON parameter; only the explicit-field projections need chunking for SQLite's bound-variable limit. A 5,000-id relation load went 9 → 3 statements (probe: 5.83 vs 5.84 ms, byte-identical maps).
- **Merging the four media-page relation reads into one JSON bundle was measured and rejected** — one statement with four `json_group_array` columns was 0.12 vs 0.09 ms for a 24-file page and 20.6 vs 16.1 ms for 5,000 files (payloads identical), so the four batched reads stay.
- **Scan findings carry the library-existence flag** — the findings page read the library row separately for its not-found check, a round trip a warm cache could answer without touching the database. The counts row of the `UNION ALL` now also selects whether the library row exists, so the check costs nothing extra: `librariesService.getScanFindings` 2 → 1 statements on the cold path (still 1 with a warm library cache), the same `entity.not_found` for a missing library and identical findings payloads.
- **Single-row detail reads carry their relations in one statement** — the media file behind `GET /v1/media-files/:id`, the playback view and `GET /v1/episodes/:id` read the row and then its relations/episode media files in a second statement; the row now anchors the relation JSON in the same statement (`mediaService.getById` 5 → 2, `episodesRepository.findByPrimaryId` 2 → 1). The bundle parser revives booleans and timestamps, and the payloads are byte-identical to the two-read results. The relation reads on pages keep their batched form: merging those into JSON coroutines measured 2–2.4× slower (0.03–0.04 vs 0.07 ms for 24 ids, 5.2 vs 12.5 ms for 5,000), so the numbers live in the loader comment and the merge stays out.
- **The media read anchors its own row, and the playback view folds its reads** — the single-id media statement now returns the file row together with its relation JSON, so `mediaService.getById` / `findByIdForRead` cost one statement instead of two (micro-probe 0.03 → 0.02 ms p50, byte-identical payload including timestamps). The playback view's bootstrap — the file, its relation graph, its markers, the root metadata row and, for episode files, the episode with its media files — comes back from one statement as well (three reads at 0.05 ms → one at 0.02 ms; adding the episode read to the bundle measured 0.03 → 0.02 ms p50 with a byte-identical episode payload), so `playbackViewService.getPlaybackView` went 9 → 5 statements (2.30 → 2.41 ms in the same suite, inside the run-to-run spread). Markers keep the `findByMediaFileId` order (start seconds, index order for ties), and the episode keeps the episode bundle's row-plus-files shape, parsed by the same reader.
- **The playback overview and the smart-play batch carry seasons and episodes in their own statement** — every series title read its seasons/episodes in a statement that followed the media+progress one; both arrays now ride the statement the caller already runs, scoped by the same id (`= ?` for one title, the same `json_each` list for a batch). `playbackViewService.getPlaybackView` went 5 → 4 statements (2.32 → 1.87 ms in the same suite), and a batch containing a series in `getSmartPlayBatch` 4 → 3 (the movie-only batch stays at 3: metadata + batch + watchlist). Payloads are byte-identical, with the arrays compared against the previous standalone seasons read for both the single and the grouped batch shape and the specials filter unchanged.
- **The playback overview merges its fixed reads** — the seasons and episodes of a title, and (for smart play) its media files and the profile's progress, were four separate prepared statements behind the overview; each pair now shares one statement (two `json_group_array` subqueries over one id scope, payloads byte-identical after revival). `playbackViewService.getPlaybackView` 11 → 9 statements, `findContinueWatchingData` 6 → 5, the 50-id `getSmartPlayBatch` 5 → 3 and the single-id smart-play read 3 → 2. Micro-benchmarks: seasons+episodes equal at 0.02 ms with a smaller tail; media+progress equal for one title (0.01 ms) and ~10% faster for the 50-id batch (0.08–0.09 → 0.07–0.08 ms).
- **The playback view dropped five statements** — the title's metadata type and numbering mode travel from the row the view already holds instead of a re-read, and the media file and episode bundles remove three more: 16 → 11 statements (2.53 → 2.41 ms in the same suite, inside the run-to-run spread).
- **The playback view's next-episode suggestion is derived from the overview it already loads** — the view ran a whole-show episode+file scan (`findEpisodesWithFilesByMetadataId` + a row-based resolver) after the overview; the overview now resolves the follow-up episode from the smart-play data it already carries (episodes, seasons and media files of the show) and returns it as `nextEpisodeFileId`, so `playbackViewService.getPlaybackView` went 4 → 3 statements. The selection keeps the old order (immediate next episode in the season, else the first playable episode of each later season; episodes without files stay in the ordering). Probe: every episode of two seeded shows — with two files removed to force the same-season fallthrough and the later-season skip — matched the previous resolver, a missing current episode still yields `null`, and the view's `nextEpisode` payload is unchanged.
- **The smart-play batch carries the watchlist flags** — the batch read and the profile's watchlist flags were two statements; the watchlist ids now ride the batch as one JSON column, scoped to the same metadata ids and profile, so `playbackProgressService.getSmartPlayBatch` went 2 → 1 statements. Probe: 0.161 → 0.101 ms p50 for 50 ids (−38%) and 0.047 → 0.031 ms for a series batch (−35%), identical flags. The separate watchlist read stays only as the fallback when the batch fails, so the old degradation behaviour is unchanged.
- **The smart-play reads carry the title row in their own statement** — the single-title read and the 50-id batch fetched `type` and the numbering mode from a separate metadata statement before running their own (the single path also had a caller-supplied pass-through); the row now rides the same statement as the media files, progress and seasons/episodes. `playbackRepository.findSmartPlayData` 2 → 1 statements, `getSmartPlayBatch` 3 → 2 for both the movie batch and a series batch, with the `metadataTypeFor` branch and the now-unused `findTypeById` / `findNumberingModeById` readers gone. Probe: the parsed metadata matches the rows read via direct SQL for movies and series, missing ids stay `null` (single and grouped), and the single and batch payloads are equal for the same title.
- **Title detail loads in one statement** — `metadataRepository.findById` 2 → 1 prepared statement (1.5 → 1.2 ms in the same suite; both figures are single-run medians, ±10% run to run), with the root row and all ten relation arrays in one pass.
- **A compressed response body is no longer copied byte by byte** — the compression middleware and the ETag builder turned the compressed body into a fresh `Uint8Array` with `Uint8Array.from`, which walks the buffer through the iterator protocol one element at a time. The body is now handed to the `Response` as a view over the bytes zlib already produced: the copy of a 64 KB body drops from 0.88 ms to 0.015 ms (measured, 200 iterations), and the compressed bytes are identical. The two per-profile aggregations that re-compress on every request (`GET /v1/metadata/:id/details-view`, `GET /v1/playback-sessions/view/:mediaFileId`) came out faster in every run — details-view +7.9%, +12.3% and +17.3% req/s over three runs, playback view +7.4% and +6.2% req/s with p95 −5.6% and −6.0%; the run-to-run spread of this suite measured at ±10% (the same code compared against itself).
- **A descending sort's tiebreaker follows the sort direction** — the API appends the primary key to every ORDER BY so offset pagination stays deterministic for non-unique sort keys, but the tiebreaker carried no direction. A descending sort therefore became `ORDER BY created_at DESC, id ASC` — a mixed-direction ORDER BY that SQLite cannot serve from one index, so it added a temp B-tree for the last term and sorted the whole filtered set. The tiebreaker now follows the sort: the unfiltered descending browse went 0.13 → 0.02 ms p50 (6.5×) in the `database` suite and lost its `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` plan step. The type-filtered shape is unchanged — its composite index is `(type, created_at)` and does not carry the id — and keeps the temp sort.
- **A rewritten image-cache file is no longer evicted as the oldest** — the eviction FIFO added a written file to a `Set`, and a `Set` leaves an existing member in place, so a hot file rewritten after an early write kept its old position and the next sweep could delete it. The write now re-inserts the name, so it moves to the newest slot.
- **Trickplay renders a file's sprite grids in parallel** — the grids are independent, and each decodes a whole row of seeks out of the source, so rendering them one after another left the machine idle between grids. They now render side by side, bounded by the cores left after the web reserve (halved, because one grid already fans out over many seeks: 1 on a two-core box, 4 on a sixteen-core one). A 600 s 1080p source at a 2 s frame interval (12 grids, 300 frames) went 17,390 → 6,524 ms end to end through the service (2.67×) on a 16-thread Ryzen 7 7800X3D.
- **A worker id that stops running no longer stays in the running-count map** — the pool decremented the count but never dropped the entry, so every worker id that ever ran — including the namespaced ids of plugin jobs — stayed in the map that the resource allocator reads on every monitoring tick. The entry is removed when the count reaches zero.
- **A boolean flag means the same thing everywhere** — the query-parameter coercion read only `"true"` as true while the admin settings codec also read `"1"`, so the same flag meant two different things depending on where it was written. One rule now backs both: `"true"`/`"1"` and `"false"`/`"0"`, and the health route's `?fresh=` reads its flag through it too.
- **Two cached routes were missing their in-flight coalescing** — `GET /v1/metadata/:id/similar` and `GET /v1/admin/resources` declared the bare `cache` option instead of the `cached` helper, so they cached the body but never coalesced concurrent requests into one handler run. The admin resources route is the one the monitoring page polls continuously.
- **A direct-stream seek reported the requested offset instead of the keyframe it started at** — the keyframe probe asks ffprobe for a packet listing (`-show_entries packet=…`), and ffprobe answers that with the packets alone: no streams, no format. The probe's shape check only accepted a format answer, so every packet listing was refused as "no usable data". The refusal was swallowed, the probe reported "no keyframe", and the seek fell back to the requested offset — while the remux itself starts at the keyframe below it, so the session's timeline ran up to one GOP ahead of the picture. A packet listing is now read as a packet listing, and the probe's cache key carries the answer shape so the two readings of the same arguments cannot be mixed.

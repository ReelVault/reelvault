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

### Fixes

- **Built-in trickplay no longer fails against the plugin artifact quota** — trickplay registered its sprites and VTT in the shared artifacts store as `pluginId: "core"`, so the 512 MB per-plugin cap rejected generation once the library filled it and `trickplay-generate` jobs failed permanently. The plugin quota is now enforced only at the `host.artifacts` boundary, while built-in generators use a configurable core budget — `system.artifacts.coreMaxStorageGb` (`0` = automatic: 5% of the artifacts volume clamped to 5–100 GB, plus a 1 GB minimum free-space floor). Exceeding the budget skips the file with a warning instead of failing, so it is generated again once space is freed. Storage-level artifact errors now carry `artifact.*` codes; the plugin quota keeps `plugin.artifact.quota_exceeded`.

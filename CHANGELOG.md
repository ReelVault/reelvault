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

### Performance

The performance work focuses primarily on reducing unnecessary database work, eliminating request waterfalls, avoiding repeated filesystem operations, and moving repeated per-item work into batched operations.

#### Database & query efficiency

- **Selective projections** — `?fields=` queries now select only the requested root columns instead of issuing `SELECT *`.
- **Cheaper existence checks** — `ping` reads only the required indexed column, while `existsForVersion` uses `EXISTS ... LIMIT 1` instead of `COUNT(*)`.
- **Reduced index overhead** — removed redundant prefix indexes, eliminating unnecessary B-tree maintenance during writes.
- **Better covering indexes** — added indexes for scanner keyset pagination, downloads, `sortTitle`, worker listing/recovery and relevant `created_at` queries.
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

#### Scanner & media processing

- **Provider-independent scan paths** — internal `scan`, `scanPath` and `getScanFindings` operations no longer load provider-priority overrides when they are not needed.
- **Removal-guard deduplication** — candidate paths are now checked once even when multiple database rows reference the same range file.
- **Concurrent cleanup events** — stale-media cleanup emits `media.file.unavailable` concurrently instead of awaiting one plugin handler per removed file.
- **Sidecar batch storage roots** — library roots are resolved once per sidecar batch instead of per media file and episode target.
- **Season/episode parsing memoization** — repeated `extractSeasonEpisode` calls on series paths are memoized, reducing execution time by roughly **28–45%**.
- **Streaming trickplay writes** — trickplay sprites are streamed directly from `BunFile` into artifact storage instead of creating a full-size in-memory buffer.
- **Safer temporary-file ownership** — temporary trickplay source cleanup is now handled by `writeFileWithRollback`.
- **Faster scanner matching** — optimized ignore-pattern matching and video-file detection to reduce repeated path and extension work.

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

#### Worker & streaming updates

- **WebSocket progress delivery** — replaced client-side worker progress polling with one throttled WebSocket broadcast per progress tick. Database write frequency is unchanged.
- **Worker deadline writes** — trigger-less workers no longer generate periodic no-op updates.
- **Playlist cushion polling** — reduced the cost of the temporary-filesystem cushion check used during streaming.

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
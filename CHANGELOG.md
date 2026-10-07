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

- **Watchlist hydration** — `GET /me/watchlist?hydrate=true` embeds each item's full metadata card, collapsing the client's list → metadata waterfall into one request.
- **Batch playback suggestions** — `GET /me/playback-suggestions?metadataIds=` returns smart-play suggestions with watchlist flags for up to 50 ids in one call (card grids and collection drawers).
- **Admin dashboard composite endpoint** — `GET /admin/dashboard-view` aggregates stats, libraries, worker operations, audit feed, error logs and update status in one admin-only call (the six requests the dashboard page used to fan out), behind a short-lived body cache like `/admin/dashboard`.
- **Stable codes for remote-access checks** — checks now return `{id, ok, code, params}` instead of server-built title/detail text; the website translates the codes.
- **Audit-log retention** — new `system.database.auditRetentionDays` setting (default 180 days, `0` = keep forever) drives a daily indexed prune; `admin_audit_logs` previously had no retention at all.
- **Worker progress over the WebSocket** — throttled `worker:progress` broadcasts let clients stop polling operations while the DB write rate stays unchanged.

### Fixes

- **Multi-episode files hit a stray unique index** — the unconditional `media_files_path_unique` (migration drift) is replaced by the partial `media_files_path_unlinked_unique`, unblocking range files; the legacy-upgrade test asserts the predicate.
- **Over-long episode ranges were rescanned forever** — the scanner computed a range span without the processor's 12-episode cap, so a file like `S01E01-E99` created one row but was re-added to `newFilePaths` on every scan (the ingest was an idempotent no-op); cap and targets now share `episodeRangeSpan`/`episodeRangeTargets`.
- **Playback progress without a profile answered 404** — eight call sites now use the shared guard and return `401 auth.profile_required`.
- **Playlist generation timeouts surfaced as generic 500s** — `waitForFile` rejects with a typed domain error and the waiter maps it to `playlist_generation_timeout`.
- **Admin-killed sessions could be recreated** — the create guard matched only the `admin.` prefix while access matched `admin`, so a session killed with `admin-stop` came back moments later; both guards now share one helper.
- **Playback diagnostics dropped tone-mapping state** — `tonemapped`/`toneMapMethod` were missing from the session projection even though the runtime and SDK expect them; fixture values are non-default so a dropped field fails the test.
- **Media audit threshold disagreed with the rest of the app** — the audit hardcoded 0.65 while admin stats and browse filters read `metadata.minMatchScore`.
- **Reoptimized images kept serving stale bytes** — the source-version cache kept the old (size, mtime) stamp for up to 5 minutes after an in-place rewrite; the write path now drops the stamp.
- **ffprobe abort listeners accumulated on reused signals** — listeners are now removed in a `finally`; settle/abort/pre-aborted paths are covered by tests.
- **Failed plugin enqueues left orphaned jobs** — the rollback passed an operation id to a worker-id filter and cancelled nothing; `enqueueWithOperation` now cancels pending jobs by operation id before removing the operation row.
- **Log tail cache could serve a stale window after rotation/cap** — the rebuild path returned the cached entry for the rest of the TTL; it now drops the entry first (test: truncate + shrink within TTL).
- **Worker scheduler rewrote null deadlines every minute** — trigger-less workers got a no-op `UPDATE` bumping `updated_at` forever; deadlines are now written only when arming or clearing.

### Performance

- Media-files page with `?fields=` selects only the requested root columns instead of `SELECT *`.
- `ping` reads one indexed column instead of the full row; `existsForVersion` uses `EXISTS ... LIMIT 1` instead of `COUNT(*)`.
- Worker retention trim is served by the index order (no TEMP B-TREE); covering indexes added for scanner keyset paging, downloads, `sortTitle`, worker list/recovery and `created_at` composites.
- Scheduler deadlines are written in one multi-row upsert per pass instead of one UPSERT per worker; claim counters aggregate per operation instead of one UPDATE per claimed job; weekly retention runs one DELETE per status instead of up to two per registered worker; stale-findings and plugin-artifact cleanup use one chunked DELETE instead of per-row deletes.
- Session-reaper active-job probe uses one chunked query per sweep instead of one SELECT per stale candidate.
- Next-episode resolution uses one ordered query instead of three statements per later season; stream prefs resolve in one LEFT JOIN instead of separate file → metadata → prefs queries.
- Internal scan paths (`scan`, `scanPath`, `getScanFindings`) read the library without loading provider-priority overrides.
- Trickplay sprite writes stream the `BunFile` straight to artifact storage (no full-size buffer copy); temp-source cleanup is owned by `writeFileWithRollback`.
- `extractSeasonEpisode` memoization on series paths: -28%…-45%.
- Logger sanitizer skips the deep clone for benign keyword strings (~2.2× faster); credential-carrying records regress +5%…+18% on the clone path.
- `worker:progress` client polling replaced by one WebSocket broadcast per progress tick (DB write rate unchanged).

Structural wins and ranged measurements that have no single numeric pair are listed as bullets above; the table below carries one numeric A/B measurement per row. Timed values are p50 (unless noted); HTTP figures are medians of 3 alternating runs and statement counts come from the query-count audit (`--strict`).

| Area | Change | Before | After | Δ |
| --- | --- | --- | --- | --- |
| HTTP | Health scenario, c=50 — throughput (security-header hook checks API/plugin prefixes before `stat`-ing the web dist) | 24,896 req/s | 30,440 req/s | +22% |
| HTTP | Health scenario, c=50 — p50 latency (same change) | 1.95 ms | 1.61 ms | -17% |
| HTTP | Health scenario, c=100 — throughput (same change) | 24,898 req/s | 32,341 req/s | +30% |
| HTTP | Health scenario, c=100 — p50 latency (same change) | 3.74 ms | 2.92 ms | -22% |
| HTTP | Smart-play card-grid batch, 50 ids — statements | 151 stmts | 4 stmts | -97% |
| HTTP | Smart-play card-grid batch, c=10 — throughput | 750 req/s | 2,250 req/s | +200% |
| HTTP | Smart-play card-grid batch, c=10 — p95 latency | 18.9 ms | 6.4 ms | -66% |
| DB | Prepared statement — metadata page of 24 (5k rows) | 0.08 ms | 0.05 ms | -37% |
| DB | Prepared statement — by-id lookup (5k rows) | 0.02 ms | 0.01 ms | -50% |
| DB | `findTypeById` — prepared (5k rows) | 0.05 ms | 0.01 ms | -80% |
| DB | `findProgressUpdateData` — prepared (5k rows) | 0.05 ms | 0.01 ms | -80% |
| DB | `findRootsById` — prepared (5k rows) | 0.04 ms | 0.02 ms | -50% |
| DB | `upsertProgress` — prepared (5k rows) | 0.04 ms | 0.02 ms | -50% |
| DB | `findNumberingModeById` — prepared | 0.06 ms | 0.01 ms | -83% |
| DB | `findMediaFileWithMetadata` — prepared | 0.02 ms | 0.01 ms | -50% |
| DB | Admin audit list count — 10 s cache | 0.33 ms | 0.09 ms | -73% |
| DB | Worker operations count — 10 s cache | 0.41 ms | 0.10 ms | -76% |
| DB | Sessions count — 10 s cache | 0.36 ms | 0.09 ms | -75% |
| DB | Collections page — cached grouped count | 2.94 ms | 0.82 ms | -72% |
| DB | Recently-added ranking, 5k titles | 5.24 ms | 3.95 ms | -25% |
| DB | Recently-added ranking, 20k titles | 19.2 ms | 8.6 ms | -55% |
| DB | Projected people list (`?fields=`) | 0.10 ms | 0.05 ms | -50% |
| DB | Projected episodes list (`?fields=`) | 0.08 ms | 0.05 ms | -38% |
| DB | FTS5 search after 1,000 title updates | 0.76 ms | 0.72 ms | -5% |
| DB | FTS5 segment table after 1,000 title updates | 44 rows | 34 rows | -23% |
| DB | Catalog refresh — changed seasons + episodes | 48 stmts | 2 stmts | -96% |
| DB | Media default flag swap | 3 stmts | 2 stmts | -33% |
| DB | Redundant prefix indexes | 10 B-trees per write | 0 | -100% |
| Workers | Trigger-less deadline rewrite | 1 no-op UPDATE/min | 0 UPDATE/min | -100% |
| Workers | Active-job snapshot with 2 pending workers | 2 reads | 1 read | -50% |
| Workers | Cancelling a pending job | 2 stmts | 1 stmt | -50% |
| Streaming | Playlist cushion poll (tmpfs) | 0.03 ms/tick | 0.01 ms/tick | -67% |
| Libraries | Narrow field reads (`{fields: id, type}`) | 2 stmts | 1 stmt | -50% |
| Libraries | `getScanFindings` — provider-priority overrides read | 3 stmts | 2 stmts | -33% |
| Sidecars | Episode/season lookups when saving 20 episode files | ~44 stmts | 2 stmts | -95% |
| Sidecars | Episode NFO read — worst-case root dispatch | 0.13 ms | 0.07 ms | -44% |
| Sidecars | Subtitle import for three sidecars | 6-9 stmts | 2 stmts | -67%…-78% |
| Sidecars | Artwork export, unchanged source+target (2 files) | 18.95 ms | 0.02 ms | ≈-100% |
| Scanner | `scanPaths` classification, 5,000 files | 0.99 ms | 0.71 ms | -29% |
| Scanner | Sidecar subtitles for 24 episodes in one directory | 1.58 ms | 0.76 ms | -52% |
| Scanner | `matchesIgnorePattern`, 500 paths × 3 patterns | 0.86 ms | 0.21 ms | -76% |
| Scanner | `isVideoFile`, 1,000 lookups | 0.65 ms | 0.10 ms | -85% |
| Plugins | Runtime mirroring, 2,000 files / 50 dirs | 28.05 ms | 6.2 ms | -78% |
| Plugins | Artifact quota totals, 1,000 files | 10.10 ms | 1.13 ms | -89% |
| Plugins | Trickplay e2e — regression check | 524.0 ms | 523.6 ms | ≈0% |
| Plugins | `emit` without subscribers, 500 emits | 0.26 ms | 0.04 ms | -85% |
| Plugins | Trickplay generate-all enqueue | 183 µs/file | 17 µs/file | -91% |
| Images | Local artwork staging, 20 MB | 2.67 ms | 1.62 ms | -39% |
| Media | Audit report parse+validate per status poll | 0.78 ms | ~0 ms (cached) | -100% |
| Admin | Log tail poll after 3 s idle, 20k-line JSONL | 7.94 ms | 0.31 ms | -96% |
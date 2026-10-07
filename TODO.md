# TODO

Follow-ups intentionally left out of earlier changes because they need
`@reelvault/sdk` contract updates (rebuild + publish the SDK, then bump
`@reelvault/sdk` in the consumers: server, website, plugins).

## Admin → Trickplay: artifact storage usage

Trickplay is no longer charged against the plugin artifact quota and uses the
configurable core budget `system.artifacts.coreMaxStorageGb` (see
`CHANGELOG.md`, v1.2.1), but the admin page still shows only coverage counts —
there is no visibility into how much of that budget is used.

- **Server**: extend `GET /admin/trickplay/stats`
  (`src/api/routes/admin/admin-trickplay.routes.ts`,
  `src/modules/trickplay/trickplay.service.ts`) with `storageBytes` and
  `storageBudgetBytes`, using
  `mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER)` and
  `resolveCoreArtifactsBudgetBytes()` from `src/modules/artifacts/`.
- **SDK** (`client/resources/admin.ts`): add the two fields to the
  `getTrickplayStats()` return type, rebuild and publish, then bump the version
  in the consumers.
- **Website**: show `used / budget` on the Admin → Trickplay page
  (`src/pages/admin/trickplay/trickplay-page.tsx`,
  `src/client/hooks/use-admin-trickplay.ts`), reusing the existing stats query
  key; add translations 1:1 to `messages/en.json` and `messages/pl.json`.
- Optional: surface the same usage on the admin resources/dashboard view.

## Artifact cleanup / management (API decision first)

There is still no API or UI to delete individual trickplay artifacts (e.g. to
free budget or drop previews for selected titles); today the only ways are
regeneration or manual file/DB cleanup. If we want it, it needs new REST
endpoints plus SDK client resources (`media.deleteArtifact`-style) and a
decision on who may delete core artifacts (admin only? per-user?).

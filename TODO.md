# TODO

Follow-ups deliberately left out of earlier changes.

## Artifact cleanup / management (API decision first)

There is still no API or UI to delete individual trickplay artifacts (e.g. to
free budget or drop previews for selected titles); today the only ways are
regeneration or manual file/DB cleanup. If we want it, it needs new REST
endpoints plus SDK client resources (`media.deleteArtifact`-style) and a
decision on who may delete core artifacts (admin only? per-user?).

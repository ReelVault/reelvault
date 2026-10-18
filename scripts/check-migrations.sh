#!/usr/bin/env sh
# Fails when the drizzle schema has changes that no migration captures.
# Used by CI (`bun run check:migrations`); local databases are untouched.
set -eu

bunx --bun drizzle-kit generate --name verify_no_drift

drift="$(git status --porcelain -- src/integrations/drizzle-orm/migrations)"
if [ -n "$drift" ]; then
	echo "Schema drift detected — run 'bun run db:generate --name \"...\"' and commit the migration:" >&2
	echo "$drift" >&2
	exit 1
fi

echo "No schema drift."

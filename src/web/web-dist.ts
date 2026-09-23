import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "@/env";

const DEFAULT_WEB_DIST_DIR_NAME = "web";

/**
 * Directory serving the bundled web UI, or null when the API-only mode stays.
 * Resolution order: APP_WEB_DIST (empty = unset), then `./web` next to the
 * working directory — the layout native release archives ship. Re-evaluated on
 * every read: static serving is not a hot path and tests swap roots freely.
 */
export function resolveWebDistRoot(): string | null {
	const configured = env.APP_WEB_DIST?.trim();
	// Only a non-empty value counts — APP_WEB_DIST="" must not resolve to cwd.
	const hasConfigured = configured !== undefined && configured.length > 0;
	const candidate = resolve(hasConfigured ? configured : join(process.cwd(), DEFAULT_WEB_DIST_DIR_NAME));

	try {
		return statSync(candidate).isDirectory() ? candidate : null;
	} catch {
		return null;
	}
}

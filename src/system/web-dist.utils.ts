import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "@/config/env.config";
import { logger } from "@/utils/logger.utils";
import { isRecord } from "@/utils/type.utils";

const DEFAULT_WEB_DIST_DIR_NAME = "web";
const VERSION_FILE = "version.json";

let webVersionCache: { key: string; version: string | null } | undefined;
let webDistRootCache: { key: string; root: string | null } | undefined;

/**
 * Version of the served web UI — written by the website build as
 * `version.json` next to `index.html`. Null when the build predates the file
 * or the web dist is not being served. Re-evaluated on mtime/size change so a
 * swapped-in `web/` directory reports the new version after a restart.
 */
export function resolveWebVersion(): string | null {
	const root = resolveWebDistRoot();
	if (!root) return null;

	const filePath = join(root, VERSION_FILE);
	try {
		const fileStat = statSync(filePath);
		if (!fileStat.isFile()) return null;

		const key = `${filePath}-${fileStat.mtimeMs}-${fileStat.size}`;
		if (webVersionCache?.key === key) return webVersionCache.version;

		const version = parseVersionField(JSON.parse(readFileSync(filePath, "utf8")));
		webVersionCache = { key, version };

		return version;
	} catch (error) {
		logger.debug("Web UI version file is unreadable", { error });
		webVersionCache = undefined;

		return null;
	}
}

function parseVersionField(payload: unknown): string | null {
	if (!isRecord(payload)) return null;

	const version = payload.version;

	return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * Directory serving the bundled web UI, or null when the API-only mode stays.
 * Resolution order: APP_WEB_DIST (empty = unset), then `./web` next to the
 * working directory — the layout native release archives ship. The stat result
 * is cached per candidate path: tests swap APP_WEB_DIST freely (each value
 * resolves on its own), and a dist replaced in place keeps its path. An empty
 * to non-empty switch to the default `./web` needs a restart.
 */
export function resolveWebDistRoot(): string | null {
	const configured = env.APP_WEB_DIST?.trim();
	// Only a non-empty value counts — APP_WEB_DIST="" must not resolve to cwd.
	const hasConfigured = configured !== undefined && configured.length > 0;
	const candidate = resolve(hasConfigured ? configured : join(process.cwd(), DEFAULT_WEB_DIST_DIR_NAME));
	if (webDistRootCache?.key === candidate) return webDistRootCache.root;

	try {
		const root = statSync(candidate).isDirectory() ? candidate : null;
		webDistRootCache = { key: candidate, root };

		return root;
	} catch {
		webDistRootCache = { key: candidate, root: null };

		return null;
	}
}

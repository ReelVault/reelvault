import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const DEFAULT_ROOT_DIR = "./data";
const DEFAULT_APP_PORT = 3030;
const SECRETS_FILE_NAME = "secrets.env";
const PERSISTED_SECRET_KEYS = ["SETUP_TOKEN", "BETTER_AUTH_SECRET"] as const;
const PERSISTED_SECRET_KEY_SET: ReadonlySet<string> = new Set(PERSISTED_SECRET_KEYS);

type PersistedSecretKey = (typeof PERSISTED_SECRET_KEYS)[number];
type SecretValues = Partial<Record<PersistedSecretKey, string>>;

/** Keys this boot generated itself — surfaced in targeted first-run log messages. */
export const generatedSecrets: Partial<Record<PersistedSecretKey, boolean>> = {};

function resolveRootDir(): string {
	const configured = process.env.ROOT_DIR?.trim();

	return configured && configured.length > 0 ? configured : DEFAULT_ROOT_DIR;
}

function generateSecret(): string {
	return randomBytes(32).toString("hex");
}

function readSecretsFile(path: string): SecretValues {
	if (!existsSync(path)) return {};

	const parsed: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

		const separator = trimmed.indexOf("=");
		if (separator <= 0) continue;

		const key = trimmed.slice(0, separator).trim();
		if (!PERSISTED_SECRET_KEY_SET.has(key)) continue;

		const value = trimmed.slice(separator + 1).trim();
		if (value.length > 0) parsed[key] = value;
	}

	return parsed;
}

function writeSecretsFile(path: string, values: SecretValues): void {
	const body = PERSISTED_SECRET_KEYS.map((key) => {
		const value = values[key];

		return typeof value === "string" && value.length > 0 ? `${key}=${value}` : `#${key}=`;
	});

	// 0600 — the file holds authentication secrets.
	writeFileSync(path, `${body.join("\n")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/**
 * Fills SETUP_TOKEN / BETTER_AUTH_SECRET from the environment, then from
 * `$ROOT_DIR/secrets.env`, generating and persisting whatever is still
 * missing. Keeps sessions stable across restarts without forcing every
 * deployment to hand-craft a .env first.
 */
function bootstrapPersistedSecrets(): void {
	const rootDir = resolveRootDir();
	const secretsPath = join(rootDir, SECRETS_FILE_NAME);
	const fromFile = readSecretsFile(secretsPath);
	const generated: SecretValues = {};
	const effective: SecretValues = {};

	// SETUP_TOKEN is opt-in (public exposure); disabled = never generated, never persisted.
	const managedKeys =
		process.env.SETUP_TOKEN_ENABLED === "true" ? PERSISTED_SECRET_KEYS : PERSISTED_SECRET_KEYS.filter((key) => key !== "SETUP_TOKEN");

	for (const key of managedKeys) {
		const fromEnv = process.env[key]?.trim();
		if (fromEnv) continue; // explicit env wins; never copied into the file

		const fromPreviousBoot = fromFile[key];
		if (fromPreviousBoot) {
			process.env[key] = fromPreviousBoot;
			effective[key] = fromPreviousBoot;
			continue;
		}

		const fresh = generateSecret();
		process.env[key] = fresh;
		effective[key] = fresh;
		generated[key] = fresh;
		generatedSecrets[key] = true;
	}

	if (Object.keys(generated).length > 0) {
		mkdirSync(rootDir, { recursive: true });
		writeSecretsFile(secretsPath, { ...fromFile, ...effective });
		console.warn(`Generated ${Object.keys(generated).join(", ")} and persisted to ${secretsPath}`);
	}
}

if (process.env.NODE_ENV === "test") {
	// In-memory only — tests must not touch the filesystem for secrets.
	for (const key of PERSISTED_SECRET_KEYS) {
		if (key === "SETUP_TOKEN" && process.env.SETUP_TOKEN_ENABLED !== "true") continue;

		if (!process.env[key]?.trim()) process.env[key] = generateSecret();
	}
} else {
	bootstrapPersistedSecrets();
}

const envSchema = z.object({
	// Production by default: a bare launch (no .env) must not silently run with
	// development-only overhead (server-timing tracing, query-logger statement
	// proxy, pretty-log worker). Development opt-in goes through .env.
	NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

	APP_PORT: z.coerce.number().positive().min(1).max(65535).default(DEFAULT_APP_PORT),
	APP_HOST: z.string().min(1).optional(),
	APP_PUBLIC_URL: z.string().optional(),
	APP_ALLOWED_ORIGINS: z.string().optional(),
	APP_SECURE: z.enum(["true", "false"]).optional(),
	// Advanced override — normally NOT required.
	// The server automatically derives the correct cookie domain from the
	// browser's Origin header (e.g. "https://rv.lan" → Domain=.rv.lan).
	// Only set this if your reverse-proxy strips or rewrites the Origin header.
	APP_COOKIE_DOMAIN: z.string().optional(),
	// How many reverse proxies in front of the server may append X-Forwarded-For.
	// 0 (default) ignores the header entirely and treats the TCP peer as the client;
	// 1 for a single nginx/Caddy/Traefik, 2 for CDN + local proxy, and so on.
	APP_TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(16).default(0),
	// Production telemetry: logs every SQLite statement slower than 100 ms (warn).
	// Off by default — enable while diagnosing storage slowness.
	APP_SLOW_QUERY_LOG: z.enum(["true", "false"]).default("false"),
	// Serves the interactive API reference (spec + UI) at /openapi.
	OPENAPI_DOCS_ENABLED: z.enum(["true", "false"]).default("true"),

	// ── Load-test / soak escape hatches — leave unset in production. ──
	// Load tests must not measure the rate limiters (see server.constants),
	// so a soak run raises or disables them without touching defaults.
	// Ceiling on the per-IP global request limiter (default 1000/min).
	REELVAULT_RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().optional(),
	// Multiplier applied to every per-route rate limit (default 1 = verbatim).
	REELVAULT_RATE_LIMIT_ROUTE_MULTIPLIER: z.coerce.number().int().positive().optional(),
	// Disables better-auth's internal limiter entirely (it keys on the socket IP,
	// which a load test cannot spread across identities).
	REELVAULT_AUTH_RATE_LIMIT_ENABLED: z.enum(["true", "false"]).default("true"),
	// Per-account login throttle (attempts per 5 minutes, default 10).
	REELVAULT_LOGIN_ACCOUNT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

	ROOT_DIR: z.string().min(1).default(DEFAULT_ROOT_DIR),
	DB_FILE_NAME: z.string().min(1).default("reelvault.sqlite"),
	// Directory with the built web UI (SPA). When unset, `./web` next to the
	// working directory is used if present; without either the server stays API-only.
	APP_WEB_DIST: z.string().optional(),

	// Absolute path to the ffmpeg/ffprobe binary. Only a fallback: a path saved
	// in the admin UI (system setting) always wins, and an unset value keeps the
	// default command resolved through PATH. Release archives with a bundled
	// ffmpeg set these from start.sh/start.bat.
	APP_FFMPEG_PATH: z.string().optional(),
	APP_FFPROBE_PATH: z.string().optional(),

	// Opt-in credential for completing first-run setup. Disabled by default so a
	// home install finishes setup straight from the wizard; enable before
	// exposing a not-yet-set-up server to an untrusted network.
	SETUP_TOKEN_ENABLED: z.enum(["true", "false"]).default("false"),
	// Only meaningful when SETUP_TOKEN_ENABLED=true (bootstrap generates and
	// persists it when absent). Explicit values must still be long enough.
	SETUP_TOKEN: z.string().min(16).optional(),
	BETTER_AUTH_SECRET: z.string().min(16),
});

export const env = envSchema.parse(process.env);

/**
 * `bun run doctor` — checks the things that most often break a fresh install and says
 * how to fix each one: Bun version, ffmpeg/ffprobe, a writable data directory, free
 * disk space, database integrity and the bundled web UI. Exit code 1 when a check fails.
 */
import { access, constants, mkdir, rm, statfs } from "node:fs/promises";
import { env } from "@/config/env.config";
import { serverConfig } from "@/config/server/server.config";
import { MIGRATIONS_DIR } from "@/integrations/drizzle-orm/constants/migrations.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { resolveWebDistRoot } from "@/system/web-dist.utils";
import { PathUtils } from "@/utils/path.utils";

type Level = "ok" | "warn" | "fail";
interface Check {
	name: string;
	level: Level;
	detail: string;
}

const MIN_BUN = [1, 4, 2] as const;
const MIN_FREE_GB = 5;
const ICONS: Record<Level, string> = { ok: "✔", warn: "!", fail: "✖" };

function atLeast(version: string, minimum: readonly number[]): boolean {
	const parts = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (const [index, needed] of minimum.entries()) {
		const actual = parts[index] ?? 0;
		if (actual !== needed) return actual > needed;
	}

	return true;
}

async function toolVersion(command: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn({ cmd: [command, "-version"], stdout: "pipe", stderr: "ignore" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

		return code === 0 ? (out.split("\n")[0]?.trim() ?? "") : undefined;
	} catch {
		return undefined;
	}
}

async function checkTool(name: string, command: string): Promise<Check> {
	const version = await toolVersion(command);
	if (version === undefined) {
		return {
			name,
			level: "fail",
			detail: `"${command}" was not found. Install ffmpeg or set the path in Settings (APP_${name.toUpperCase()}_PATH).`,
		};
	}

	return { name, level: "ok", detail: version };
}

async function checkDataDirectory(): Promise<Check> {
	const probe = PathUtils.join(env.ROOT_DIR, `.doctor-${process.pid}`);
	try {
		await mkdir(env.ROOT_DIR, { recursive: true });
		await Bun.write(probe, "ok");
		await rm(probe, { force: true });

		return { name: "data directory", level: "ok", detail: `${env.ROOT_DIR} is writable` };
	} catch (error) {
		return {
			name: "data directory",
			level: "fail",
			detail: `${env.ROOT_DIR} is not writable (${error instanceof Error ? error.message : String(error)}). Fix the permissions or set ROOT_DIR.`,
		};
	}
}

async function checkDisk(): Promise<Check> {
	try {
		const stats = await statfs(env.ROOT_DIR);
		const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
		const level: Level = freeGb < MIN_FREE_GB ? "warn" : "ok";

		return {
			name: "disk space",
			level,
			detail: `${freeGb.toFixed(1)} GB free${level === "warn" ? ` (transcoding and trickplay need room — aim for ${MIN_FREE_GB}+ GB)` : ""}`,
		};
	} catch (error) {
		return { name: "disk space", level: "warn", detail: `could not be read (${error instanceof Error ? error.message : String(error)})` };
	}
}

function checkDatabase(): Check {
	try {
		const { applied } = databaseFactory.migrate();
		const result = databaseFactory.sqlite.query("PRAGMA quick_check").values();
		const problems = result.map((row) => String(row[0])).filter((line) => line !== "ok");
		if (problems.length > 0)
			return { name: "database", level: "fail", detail: `integrity check failed: ${problems.join("; ")}. Restore a backup.` };

		return {
			name: "database",
			level: "ok",
			detail: `${serverConfig.paths.sqlite} is sound (${applied} migration(s) applied now, from ${MIGRATIONS_DIR})`,
		};
	} catch (error) {
		return { name: "database", level: "fail", detail: error instanceof Error ? error.message : String(error) };
	}
}

async function checkWebUi(): Promise<Check> {
	const root = resolveWebDistRoot();
	if (!root)
		return {
			name: "web UI",
			level: "warn",
			detail: "no bundled web UI found — the server will run API-only (set APP_WEB_DIST or place a web/ folder next to it)",
		};

	try {
		await access(PathUtils.join(root, "index.html"), constants.R_OK);

		return { name: "web UI", level: "ok", detail: root };
	} catch {
		return { name: "web UI", level: "fail", detail: `${root} has no readable index.html` };
	}
}

const checks: Check[] = [
	{
		name: "bun",
		level: atLeast(Bun.version, MIN_BUN) ? "ok" : "fail",
		detail: atLeast(Bun.version, MIN_BUN) ? `v${Bun.version}` : `v${Bun.version} is too old — ${MIN_BUN.join(".")}+ is required`,
	},
	await checkTool("ffmpeg", serverConfig.ffmpeg.path),
	await checkTool("ffprobe", serverConfig.ffprobe.path),
	await checkDataDirectory(),
	await checkDisk(),
	checkDatabase(),
	await checkWebUi(),
];

for (const check of checks) console.log(`${ICONS[check.level]} ${check.name.padEnd(15)} ${check.detail}`);

databaseFactory.shutdown();
const failed = checks.filter((check) => check.level === "fail").length;
const warned = checks.filter((check) => check.level === "warn").length;
let summary = "All checks passed.";
if (failed > 0) summary = `${failed} problem(s) need fixing.`;
else if (warned > 0) summary = `All good, with ${warned} warning(s).`;
console.log(`\n${summary}`);
process.exitCode = failed > 0 ? 1 : 0;

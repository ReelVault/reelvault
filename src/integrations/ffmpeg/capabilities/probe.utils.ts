import { serverConfig } from "@/config/server/server.config";
import { spawnAndCollect } from "@/integrations/ffmpeg/ffmpeg.process-runner";

const filterLineRegex = /^\s*[.TSC]+\s+([a-z0-9_]+)\s+/i;
const versionLineRegex = /^ffmpeg version\s+(.+?)(?:\s+Copyright\b|$)/m;
const encoderFlagsRegex = /^[A-Za-z.]{6,9}$/;
const encoderNameRegex = /^[a-z0-9_]+$/;
const whitespaceRegex = /\s+/;

/** Runs the configured FFmpeg binary for a diagnostic probe. */
export function runFfmpegDiagnostic(args: string[], timeoutMs?: number) {
	return spawnAndCollect({ cmd: [serverConfig.ffmpeg.path, ...args], timeoutMs, purpose: "diagnostic" });
}

/** The version from `ffmpeg -version`, or undefined when the banner is unexpected. */
export function parseFfmpegVersion(stdout: string): string | undefined {
	return stdout.match(versionLineRegex)?.[1]?.trim();
}

/** Filter names from `ffmpeg -filters`. */
export function parseFilterNames(stdout: string): Set<string> {
	return stdout.split("\n").reduce<Set<string>>((set, line) => {
		const match = line.match(filterLineRegex);
		if (match?.[1]) set.add(match[1]);

		return set;
	}, new Set());
}

/** Accelerator names from `ffmpeg -hwaccels`, without the header lines. */
export function parseHwaccelNames(stdout: string): Set<string> {
	return stdout.split("\n").reduce<Set<string>>((set, raw) => {
		const line = raw.trim();
		if (line && !line.startsWith("Hardware") && !line.startsWith("---")) set.add(line);

		return set;
	}, new Set());
}

/**
 * Extracts encoder names from `ffmpeg -encoders` output. Entry lines start with a
 * fixed-width flag column (6 chars, 7 in older FFmpeg) like `V....D` — matching
 * flags by letters breaks whenever FFmpeg uses one outside the expected set
 * (nvenc/vaapi/amf carry `D` = direct rendering while qsv does not), so the
 * flags column is matched shape-only and the name is taken as the second token.
 */
export function parseEncoderNames(output: string): ReadonlySet<string> {
	return output.split("\n").reduce<Set<string>>((set, line) => {
		const parts = line.trim().split(whitespaceRegex);
		if (parts.length >= 2 && encoderFlagsRegex.test(parts[0] ?? "") && encoderNameRegex.test(parts[1] ?? "")) {
			const name = parts[1];
			if (name) set.add(name);
		}

		return set;
	}, new Set());
}

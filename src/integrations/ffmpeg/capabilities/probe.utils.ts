import { existsSync } from "node:fs";
import { serverConfig } from "@/config/server/server.config";
import { spawnAndCollect } from "@/integrations/ffmpeg/ffmpeg.process-runner";

const filterLineRegex = /^\s*[.TSC]+\s+([a-z0-9_]+)\s+/i;
const versionLineRegex = /^ffmpeg version\s+(.+?)(?:\s+Copyright\b|$)/m;
const encoderFlagsRegex = /^[A-Za-z.]{6,9}$/;
const encoderNameRegex = /^[a-z0-9_]+$/;
const whitespaceRegex = /\s+/;

let cachedDriDevice: string | null | undefined;

/** DRM render node used for vaapi/qsv (or the forced hwaccelDevice), null when none was found. */
export function getDetectedDriDevice(): string | null {
	if (cachedDriDevice !== undefined) return cachedDriDevice;

	const configuredDevice = serverConfig.ffmpeg.hwaccelDevice.trim();
	if (configuredDevice) {
		cachedDriDevice = configuredDevice;
	} else if (process.platform === "linux") {
		if (existsSync("/dev/dri/renderD128")) cachedDriDevice = "/dev/dri/renderD128";
		else if (existsSync("/dev/dri/card0")) cachedDriDevice = "/dev/dri/card0";
		else cachedDriDevice = null;
	} else {
		cachedDriDevice = null;
	}

	return cachedDriDevice;
}

/** Runs the configured FFmpeg binary for a diagnostic probe. */
export function runFfmpegDiagnostic(args: string[], timeoutMs?: number) {
	return spawnAndCollect({ cmd: [serverConfig.ffmpeg.path, ...args], timeoutMs, purpose: "diagnostic" });
}

/** The version from `ffmpeg -version`, or undefined when the banner is unexpected. */
export function parseFfmpegVersion(stdout: string): string | undefined {
	return versionLineRegex.exec(stdout)?.[1]?.trim();
}

/** Filter names from `ffmpeg -filters`. */
export function parseFilterNames(stdout: string): Set<string> {
	const names = new Set<string>();
	for (const line of stdout.split("\n")) {
		const match = filterLineRegex.exec(line);
		if (match?.[1]) names.add(match[1]);
	}

	return names;
}

/** Accelerator names from `ffmpeg -hwaccels`, without the header lines. */
export function parseHwaccelNames(stdout: string): Set<string> {
	const names = new Set<string>();
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line && !line.startsWith("Hardware") && !line.startsWith("---")) names.add(line);
	}

	return names;
}

/**
 * Extracts encoder names from `ffmpeg -encoders` output. Entry lines start with a
 * fixed-width flag column (6 chars, 7 in older FFmpeg) like `V....D` — matching
 * flags by letters breaks whenever FFmpeg uses one outside the expected set
 * (nvenc/vaapi/amf carry `D` = direct rendering while qsv does not), so the
 * flags column is matched shape-only and the name is taken as the second token.
 */
export function parseEncoderNames(output: string): ReadonlySet<string> {
	const names = new Set<string>();
	for (const line of output.split("\n")) {
		const parts = line.trim().split(whitespaceRegex);
		if (parts.length >= 2 && encoderFlagsRegex.test(parts[0] ?? "") && encoderNameRegex.test(parts[1] ?? "")) {
			const name = parts[1];
			if (name) names.add(name);
		}
	}

	return names;
}

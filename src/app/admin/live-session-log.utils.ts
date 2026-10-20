import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { file as bunFile } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { operationLogSegment } from "@/integrations/ffmpeg/ffmpeg.operation-log";
import { MIB } from "@/utils/bytes.utils";
import { isMissingFile } from "@/utils/domain.errors";

/** Logs read for one archive stop at this total size; the timeline records when they were cut. */
export const SESSION_LOG_MAX_BYTES = 64 * MIB;

/** `FfmpegOperationLog` file names end with the operation id, after the date and time it started. */
const OPERATION_LOG_NAME_REGEX = /^FFmpeg\.(?:Transcode|DirectStream)-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)\.log$/;
const OPERATION_LOG_FIELD_REGEX = /^(mode|startedAt|processId|finishedAt|durationMs|exitCode|signalCode|error): (.*)$/;
const TIMESTAMP_SEPARATORS_REGEX = /[:.]/g;

export interface FfmpegRunSummary {
	file: string;
	mode: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number | null;
	processId: number | null;
	exitCode: string | null;
	signalCode: string | null;
	error: string | null;
}

export interface SessionLogFile {
	/** Path under the ffmpeg log directory, e.g. `2026-10-09/FFmpeg.Transcode-….log`. */
	name: string;
	bytes: Uint8Array;
}

/** Whether a log file was written for one of the given (file-name) operation ids. */
export function isSessionOperationLog(fileName: string, segments: readonly string[]): boolean {
	const operationId = OPERATION_LOG_NAME_REGEX.exec(fileName)?.[1];

	return operationId !== undefined && segments.includes(operationId);
}

/** The value of a header or footer field; the log writes the literal `null` for an absent value. */
function fieldValue(fields: ReadonlyMap<string, string>, key: string): string | null {
	const value = fields.get(key);

	return value === undefined || value === "null" ? null : value;
}

function numericField(fields: ReadonlyMap<string, string>, key: string): number | null {
	const value = fieldValue(fields, key);
	if (value === null) return null;

	const parsed = Number(value);

	return Number.isFinite(parsed) ? parsed : null;
}

/** Reads the header and footer lines an operation log writes around one ffmpeg run. */
export function summarizeFfmpegLog(file: string, text: string): FfmpegRunSummary {
	const fields = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = OPERATION_LOG_FIELD_REGEX.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined && !fields.has(match[1])) fields.set(match[1], match[2]);
	}

	return {
		file,
		mode: fieldValue(fields, "mode"),
		startedAt: fieldValue(fields, "startedAt"),
		finishedAt: fieldValue(fields, "finishedAt"),
		durationMs: numericField(fields, "durationMs"),
		processId: numericField(fields, "processId"),
		exitCode: fieldValue(fields, "exitCode"),
		signalCode: fieldValue(fields, "signalCode"),
		error: fieldValue(fields, "error"),
	};
}

/** Reads the operation logs of a session from every day's ffmpeg directory, oldest day first. */
export async function readSessionLogFiles(segments: readonly string[]): Promise<{ files: SessionLogFile[]; truncated: boolean }> {
	const root = join(serverConfig.paths.logs, "ffmpeg");
	let days: Dirent[];
	try {
		days = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissingFile(error)) return { files: [], truncated: false };

		throw error;
	}

	const files: SessionLogFile[] = [];
	let total = 0;
	let truncated = false;
	for (const day of days.filter((entry) => entry.isDirectory()).toSorted((a, b) => a.name.localeCompare(b.name))) {
		const dayPath = join(root, day.name);
		for (const entry of await readdir(dayPath, { withFileTypes: true })) {
			if (!(entry.isFile() && isSessionOperationLog(entry.name, segments))) continue;

			const path = join(dayPath, entry.name);
			const { size } = await bunFile(path).stat();
			if (total + size > SESSION_LOG_MAX_BYTES) {
				truncated = true;
				continue;
			}

			total += size;
			files.push({ name: `${day.name}/${entry.name}`, bytes: await bunFile(path).bytes() });
		}
	}

	return { files, truncated };
}

/** A zip with every log file of the session under `ffmpeg/` and a `timeline.json` of its runs by start time. */
export async function buildSessionLogArchive(sessionId: string, files: readonly SessionLogFile[], truncated: boolean): Promise<Uint8Array> {
	// Loaded on the first session download, not at boot.
	const { strToU8, zipSync } = await import("fflate");
	const decoder = new TextDecoder();
	const runs = files
		.map((file) => summarizeFfmpegLog(file.name, decoder.decode(file.bytes)))
		.toSorted((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

	const entries: Record<string, Uint8Array> = {
		"timeline.json": strToU8(JSON.stringify({ sessionId, truncated, runs }, null, 2)),
	};
	for (const file of files) entries[`ffmpeg/${file.name}`] = file.bytes;

	return zipSync(entries, { level: 6 });
}

/** Archive file name for a session's logs; the session id keeps only the characters a log name keeps. */
export function sessionLogArchiveName(sessionId: string, now: Date): string {
	return `reelvault-session-${operationLogSegment(sessionId)}-${now.toISOString().replace(TIMESTAMP_SEPARATORS_REGEX, "-")}.zip`;
}

/** The name segments a session's logs can carry: its own id, and its operation id once one is attached. */
export function sessionLogSegments(sessionId: string, operationId: string | undefined): string[] {
	const segments = [operationLogSegment(sessionId)];
	if (operationId !== undefined) segments.push(operationLogSegment(operationId));

	return [...new Set(segments)];
}

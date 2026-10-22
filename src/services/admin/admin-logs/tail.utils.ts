import { file as bunFile } from "bun";
import { DomainError, isMissingFile } from "@/utils/domain.errors";
import { readFile } from "@/utils/file.utils";
import { safeParseJson } from "@/utils/json.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { isNonEmptyString, isRecord, normalizeLower } from "@/utils/type.utils";
import { adminLogsLog } from "./admin-logs.logger";
import { resolveLogFilePath } from "./files.service";
import { LOG_TAIL_BYTES, LOG_TAIL_LINE_CAP, type LogTailEntry } from "./shared.types";

/**
 * Log viewers poll every few seconds while the logger itself keeps appending
 * to the same file, so a stat-keyed cache invalidates on every request.
 * The tail is therefore tracked incrementally: only bytes appended since the
 * last read are parsed, and the entry rebuilds from the 2 MiB window when it
 * expires, rotates (file shrank) or grows past the line cap. The TTL only
 * bounds memory staleness — new bytes are always read incrementally — so it
 * is sized to cover a viewer that polls slower than its refresh interval
 * without forcing a full 2 MiB re-parse (30 s).
 */
const logTailCache = new MemoryCache<LogTailEntry>({ ttlMs: 30_000, maxSize: 4, name: "admin.logTail" });

/**
 * Serves the log tail from the cache when only bytes were appended since the last read: only the new bytes are
 * parsed. A rotated, truncated or over-cap entry is rebuilt from the tail window.
 */
export async function readLogTailLines(fileId?: string): Promise<LogTailEntry> {
	const { filePath } = resolveLogFilePath(fileId);
	try {
		const stats = await bunFile(filePath).stat();
		const cached = logTailCache.get(filePath);

		if (cached && stats.size >= cached.readOffset && cached.lines.length < LOG_TAIL_LINE_CAP) {
			if (stats.size > cached.readOffset) {
				const appended = await bunFile(filePath).slice(cached.readOffset, stats.size).text();
				appendTailLines(cached, appended);
				cached.readOffset = stats.size;
				logTailCache.set(filePath, cached);
			}

			return cached;
		}

		// The size/cap check above established the cached entry is unusable
		// (rotated, truncated or past the line cap). Drop it so getOrSet
		// rebuilds instead of returning the stale entry for the rest of its TTL.
		logTailCache.delete(filePath);

		return await logTailCache.getOrSet(filePath, () => readLogTailWindow(fileId));
	} catch (error) {
		// A log file that does not exist yet (fresh install, after a purge) is an empty log,
		// not a failure: the dashboard reads logs alongside everything else.
		if (isMissingFile(error)) return { lines: [], parsed: [], lowerLines: [], readOffset: 0, carry: "" };
		if (error instanceof DomainError && error.category === "not_found") throw error;

		adminLogsLog.logger.error("Failed to read log file tail", error, { fileId, filePath });
		throw new DomainError("internal", `Log file could not be read: ${fileId ?? filePath}`, { cause: error, code: "logs.read_failed" });
	}
}

/**
 * Reads only the tail of a log file (last ~2 MB) to avoid loading potentially
 * gigabyte-sized log files fully into memory. Small files are read whole.
 */
async function readLogTail(fileId?: string): Promise<{ content: string; truncated: boolean }> {
	const { filePath } = resolveLogFilePath(fileId);
	try {
		const fileSize = (await bunFile(filePath).stat()).size;
		if (fileSize <= LOG_TAIL_BYTES) {
			const content = await readFile(filePath, "utf-8");

			return { content, truncated: false };
		}

		const content = await bunFile(filePath)
			.slice(fileSize - LOG_TAIL_BYTES, fileSize)
			.text();

		return { content, truncated: true };
	} catch (error) {
		throw new DomainError("not_found", `Log file not found: ${fileId ?? filePath}`, { cause: error, code: "logs.file_not_found" });
	}
}

async function readLogTailWindow(fileId?: string): Promise<LogTailEntry> {
	const { filePath } = resolveLogFilePath(fileId);
	const { content, truncated } = await readLogTail(fileId);
	const lines = content.split("\n");
	// When reading a byte-slice tail, the first line may be cut mid-write — skip it.
	if (truncated && lines.length > 0) lines.shift();

	const entry: LogTailEntry = {
		lines: [],
		parsed: [],
		lowerLines: [],
		// The window ends at the CURRENT size — otherwise the next read would
		// treat the whole pre-window file as "appended" and re-read it.
		readOffset: (await bunFile(filePath).stat()).size,
		carry: "",
	};
	appendTailLines(entry, lines.join("\n"));
	entry.carry = "";

	return entry;
}

/** Splits appended text into complete lines, carrying a trailing partial line over. */
function appendTailLines(entry: LogTailEntry, appended: string): void {
	const incoming = (entry.carry + appended).split("\n");
	entry.carry = incoming.pop() ?? "";
	for (const line of incoming) {
		if (!isNonEmptyString(line)) continue;
		const value = safeParseJson(line);
		entry.lines.push(line);
		entry.parsed.push(isRecord(value) ? value : null);
		entry.lowerLines.push(normalizeLower(line));
	}
}

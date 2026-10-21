import type { AdminLogEntry } from "@reelvault/sdk/common";
import { normalizeLower } from "@/utils/type.utils";

const ERROR_LEVELS = new Set(["warn", "error", "fatal"]);
const PINO_LEVEL_NAMES: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

/** The query's matching rules, lowercased once per request. */
export interface LogWindowFilter {
	targetLevels: Set<string> | undefined;
	hasErrorsFilter: boolean;
	searchLower: string | undefined;
	excludeLower: string | undefined;
	moduleLower: string | undefined;
	fromMs: number | undefined;
	toMs: number | undefined;
}

/** Module and time of one entry. Plain-text lines carry neither, so a module or time filter drops them. */
interface LogEntryScope {
	moduleLower?: string | undefined;
	timeMs?: number | undefined;
}

const PLAIN_LOG_SCOPE: LogEntryScope = {};

function matchesLevelFilter(levelName: string, targetLevels: Set<string> | undefined, hasErrorsFilter: boolean): boolean {
	if (!targetLevels) return true;

	const levelLower = levelName.toLowerCase();

	return targetLevels.has(levelLower) || (hasErrorsFilter && ERROR_LEVELS.has(levelLower));
}

function resolveJsonLogLevelName(obj: Record<string, unknown>): string {
	const numericLevel = obj.level;
	if (typeof numericLevel === "number") return PINO_LEVEL_NAMES[numericLevel] ?? "info";

	if (typeof obj.level === "string") return obj.level;

	return "info";
}

function passesLogFilters(levelName: string, lineLower: string, filter: LogWindowFilter, scope: LogEntryScope): boolean {
	if (!matchesLevelFilter(levelName, filter.targetLevels, filter.hasErrorsFilter)) return false;

	if (filter.searchLower && !lineLower.includes(filter.searchLower)) return false;

	if (filter.excludeLower && lineLower.includes(filter.excludeLower)) return false;

	if (filter.moduleLower && scope.moduleLower !== filter.moduleLower) return false;

	if (filter.fromMs !== undefined && (scope.timeMs === undefined || scope.timeMs < filter.fromMs)) return false;

	if (filter.toMs !== undefined && (scope.timeMs === undefined || scope.timeMs > filter.toMs)) return false;

	return true;
}

function jsonLogScope(obj: Record<string, unknown>): LogEntryScope {
	const timeMs = typeof obj.time === "string" || typeof obj.time === "number" ? new Date(obj.time).getTime() : Number.NaN;

	return {
		moduleLower: typeof obj.module === "string" ? normalizeLower(obj.module) : undefined,
		timeMs: Number.isNaN(timeMs) ? undefined : timeMs,
	};
}

export function jsonLogLineMatches(obj: Record<string, unknown>, lineLower: string, filter: LogWindowFilter): boolean {
	return passesLogFilters(resolveJsonLogLevelName(obj), lineLower, filter, jsonLogScope(obj));
}

export function buildJsonLogEntry(obj: Record<string, unknown>): AdminLogEntry {
	const levelName = resolveJsonLogLevelName(obj);
	const timeValue = typeof obj.time === "string" || typeof obj.time === "number" ? obj.time : undefined;

	return {
		...obj,
		levelName,
		timestamp: timeValue ? new Date(timeValue).toISOString() : new Date().toISOString(),
	};
}

function classifyPlainLogLevel(line: string, lineLower: string): "debug" | "error" | "info" | "warn" {
	if (lineLower.includes("error") || line.includes("[error]")) return "error";

	if (lineLower.includes("warn") || line.includes("[stderr]")) return "warn";

	if (lineLower.includes("debug") || line.includes("[progress]")) return "debug";

	return "info";
}

export function plainLogLineMatches(line: string, lineLower: string, filter: LogWindowFilter): boolean {
	return passesLogFilters(classifyPlainLogLevel(line, lineLower), lineLower, filter, PLAIN_LOG_SCOPE);
}

export function buildPlainLogEntry(line: string, lineLower: string): AdminLogEntry {
	return { msg: line, levelName: classifyPlainLogLevel(line, lineLower), timestamp: new Date().toISOString() };
}

/** Parses a `from`/`to` bound; an unparsable value leaves that side open. */
export function parseLogBound(value: string | undefined): number | undefined {
	if (!value) return undefined;

	const ms = Date.parse(value);

	return Number.isNaN(ms) ? undefined : ms;
}

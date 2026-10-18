import type { AdminLogEntry, AdminLogsPage } from "@reelvault/sdk/common";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { normalizeLower } from "@/utils/type.utils";
import {
	buildJsonLogEntry,
	buildPlainLogEntry,
	jsonLogLineMatches,
	type LogWindowFilter,
	parseLogBound,
	plainLogLineMatches,
} from "./filter.utils";
import { type AdminLogsState, LOG_MAX_PARSED_LINES, LOG_TAIL_BYTES } from "./shared.types";
import { readLogTailLines } from "./tail.utils";

export interface AdminLogsQuery {
	fileId?: string;
	level?: string;
	q?: string;
	module?: string;
	exclude?: string;
	from?: string;
	to?: string;
	limit?: number;
	page?: number;
}

/** Newest-first filtered page of one log file. Entries outside the page are counted, never materialized. */
export async function getLogs(state: AdminLogsState, query?: AdminLogsQuery): Promise<AdminLogsPage> {
	const { lines, parsed, lowerLines, readOffset } = await readLogTailLines(state, query?.fileId);
	const maxLines = Math.min(lines.length, LOG_MAX_PARSED_LINES);
	const parsedEntries: AdminLogEntry[] = [];

	const searchLower = query?.q ? normalizeLower(query.q) : undefined;
	const targetLevels = query?.level && query.level !== "all" ? new Set(query.level.split(",").map((l) => normalizeLower(l))) : undefined;
	const hasErrorsFilter = targetLevels?.has("errors") ?? false;

	const { page, limit } = QueryPagination.resolvePageParams(query ?? {}, { defaultLimit: 100 });
	const windowStart = (page - 1) * limit;
	const windowEnd = windowStart + limit;
	let totalMatching = 0;

	const filter: LogWindowFilter = {
		targetLevels,
		hasErrorsFilter,
		searchLower,
		excludeLower: query?.exclude ? normalizeLower(query.exclude) : undefined,
		moduleLower: query?.module ? normalizeLower(query.module) : undefined,
		fromMs: parseLogBound(query?.from),
		toMs: parseLogBound(query?.to),
	};

	for (let i = lines.length - 1; i >= 0 && lines.length - i <= maxLines; i--) {
		const line = lines[i];
		if (!line) continue;

		const obj = parsed[i];
		const lineLower = lowerLines[i] ?? "";
		const matches = obj ? jsonLogLineMatches(obj, lineLower, filter) : plainLogLineMatches(line, lineLower, filter);
		if (!matches) continue;

		// Entries outside the pagination window are counted, never materialized —
		// a broad search can match thousands of lines while the page holds a few.
		if (totalMatching >= windowStart && totalMatching < windowEnd) {
			parsedEntries.push(obj ? buildJsonLogEntry(obj) : buildPlainLogEntry(line, lineLower));
		}

		totalMatching++;
	}

	return {
		...QueryPagination.buildAdminPagination({ total: totalMatching, page, limit }),
		truncated: readOffset > LOG_TAIL_BYTES,
		windowBytes: LOG_TAIL_BYTES,
		data: parsedEntries,
	};
}

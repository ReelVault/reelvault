import { MIB } from "@/utils/bytes.utils";
import type { createLogger } from "@/utils/logger.utils";
import type { MemoryCache } from "@/utils/memory.cache";

export interface AdminLogsServiceDependencies {
	logFilePath: string;
}

export const LOG_TAIL_BYTES = 2 * MIB;
export const LOG_MAX_PARSED_LINES = 10_000;
/** Appends beyond this many cached lines force a rebuild from the tail window. */
export const LOG_TAIL_LINE_CAP = 40_000;

export interface LogTailEntry {
	lines: string[];
	parsed: Array<Record<string, unknown> | null>;
	lowerLines: string[];
	/** File size the cache has consumed so far — appends past it are read incrementally. */
	readOffset: number;
	carry: string;
}

export interface AdminLogsState {
	readonly serviceName: string;
	readonly logger: ReturnType<typeof createLogger>;
	readonly dependencies: AdminLogsServiceDependencies;
	readonly logTailCache: MemoryCache<LogTailEntry>;
}

/** Arguments of a state-taking service function, without the leading state parameter. */
export type WithoutState<F> = F extends (state: never, ...rest: infer R) => unknown ? R : never;

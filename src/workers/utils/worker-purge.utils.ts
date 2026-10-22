import { daysAgo } from "@/config/server/server.constants";
import type { TerminalJobStatus } from "@/repositories/worker-jobs/shared.types";

export interface TerminalPurgeOptions {
	status?: TerminalJobStatus | undefined;
	olderThanDays?: number | undefined;
}

/** A terminal purge as the admin asks for it: which states, how old, and a dry run. */
export interface TerminalPurgeRequest extends TerminalPurgeOptions {
	dryRun?: boolean | undefined;
}

/**
 * The filter a terminal purge uses: the states to remove and the age from
 * which they count. A purge without an age removes every terminal row.
 */
export function terminalPurgeFilter(options: TerminalPurgeOptions): {
	status?: TerminalJobStatus | undefined;
	cutoffDate: Date | undefined;
} {
	const cutoffDate = options.olderThanDays && options.olderThanDays > 0 ? daysAgo(options.olderThanDays) : undefined;

	return { status: options.status, cutoffDate };
}

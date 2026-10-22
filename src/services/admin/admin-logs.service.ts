import { getLogBundle } from "./admin-logs/bundle.service";
import { deleteLogFile, getLogFileDownloadContent, listLogFiles } from "./admin-logs/files.service";
import { purgeOldLogs } from "./admin-logs/purge.service";
import { getLogs } from "./admin-logs/query.service";

/** The admin log viewer: the log files, their filtered tail, downloads, the support bundle and the retention purge. */
export const adminLogsService = {
	listLogFiles,
	/** Returns a streaming file handle for log downloads instead of buffering the file in memory. */
	getLogFileDownloadContent,
	deleteLogFile,
	purgeOldLogs,
	getLogs,
	getLogBundle,
};

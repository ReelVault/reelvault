import { createLogger } from "@/utils/logger.utils";
import type { SafeExecuteContext } from "@/utils/safe-execute.utils";

/** The name and logger the admin log use cases report through. */
export const adminLogsLog: SafeExecuteContext = { serviceName: "AdminLogsService", logger: createLogger("AdminLogsService") };

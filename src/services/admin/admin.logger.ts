import { createLogger } from "@/utils/logger.utils";
import type { SafeExecuteContext } from "@/utils/safe-execute.utils";

/** The name and logger the admin use cases report through. */
export const adminLog: SafeExecuteContext = { serviceName: "AdminService", logger: createLogger("AdminService") };

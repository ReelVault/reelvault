import { createLogger } from "@/utils/logger.utils";
import type { SafeExecuteContext } from "@/utils/safe-execute.utils";

/** The name and logger the library use cases report through. */
export const librariesLog: SafeExecuteContext = { serviceName: "LibrariesService", logger: createLogger("LibrariesService") };

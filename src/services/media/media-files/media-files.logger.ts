import { createLogger } from "@/utils/logger.utils";
import type { SafeExecuteContext } from "@/utils/safe-execute.utils";

/** The name and logger every media file use case reports through. */
export const mediaFilesLog: SafeExecuteContext = { serviceName: "MediaService", logger: createLogger("MediaService") };

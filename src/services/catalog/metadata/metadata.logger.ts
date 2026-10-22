import { createLogger } from "@/utils/logger.utils";
import type { SafeExecuteContext } from "@/utils/safe-execute.utils";

/** The name and logger the metadata use cases report through. */
export const metadataLog: SafeExecuteContext = { serviceName: "MetadataService", logger: createLogger("MetadataService") };

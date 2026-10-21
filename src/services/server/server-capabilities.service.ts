import type { ServerCapabilities } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";

export const serverCapabilitiesService = {
	/** Read live, so a setting change shows on the next request without a restart. */
	get(): ServerCapabilities {
		return { trickplay: serverConfig.trickplay.enabled, downloads: serverConfig.downloads.enabled };
	},
};

import { DAY, serverConstants } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import { clamp } from "@/utils/math.utils";

/** Plugin storage, notifications, lifecycle and provider caches. */
export const pluginConfig = {
	/** Plugin Details Cache */
	plugins: {
		...serverConstants.plugins,
		get blobs() {
			return {
				...serverConstants.plugins.blobs,
				retentionMs: systemSettingsStore.get("plugins.blobs.retentionDays") * DAY,
				cleanupConcurrency: systemResourcesService.getIoConcurrency(),
			};
		},
		get notifications() {
			return {
				...serverConstants.plugins.notifications,
				maxPerDayPerPlugin: systemSettingsStore.get("plugins.notifications.maxPerDayPerPlugin"),
			};
		},
		get artifacts() {
			return {
				...serverConstants.plugins.artifacts,
				cleanupConcurrency: systemResourcesService.getIoConcurrency(),
			};
		},
		get lifecycle() {
			return {
				...serverConstants.plugins.lifecycle,
				// Importing plugin modules is JS-eval CPU work at boot.
				loadConcurrency: clamp(Math.ceil(systemResourcesService.getMetrics().capacity / 2), 1, 4),
				disposeConcurrency: systemResourcesService.getIoConcurrency(),
				// JS eval on an RPi is several× slower — don't fail good plugins.
				loadTimeoutMs: systemResourcesService.scaledTimeoutMs(serverConstants.plugins.lifecycle.loadTimeoutMs),
			};
		},
		providers: {
			...serverConstants.plugins.providers,
			get detailsCacheTtlMs() {
				return systemSettingsStore.get("plugins.providers.detailsCacheTtlMs");
			},
			// ProviderDetails rows run 10-50 KB — scale with installed RAM.
			get detailsCacheMaxSize() {
				return systemResourcesService.getRamScaledCacheEntries(60, 200, 2000);
			},
		},
	},
};

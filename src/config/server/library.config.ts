import { serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";

/** Library content: media types, images, scanning, markers, collections and metadata. */
export const libraryConfig = {
	/** Media & Audio Engine */
	media: {
		get supportedVideoExtensions() {
			return systemSettingsStore.get("scanning.supportedVideoExtensions");
		},
		get ignorePatterns() {
			return systemSettingsStore.get("scanning.ignorePatterns");
		},
	},

	/** Image Optimization & Dimensions */
	images: {
		...serverConstants.images,
		get maxWidth() {
			return systemSettingsStore.get("images.maxWidth");
		},
		get maxHeight() {
			return systemSettingsStore.get("images.maxHeight");
		},
		get maxUploadBytes() {
			return systemSettingsStore.get("images.maxUploadBytes");
		},
		optimization: {
			get defaultQuality() {
				return systemSettingsStore.get("images.defaultQuality");
			},
			get defaultWidth() {
				return systemSettingsStore.get("images.defaultWidth");
			},
		},
	},

	/** Library Scanner & FFprobe Concurrency */
	scanning: {
		get pathScanTimeoutMs() {
			return systemSettingsStore.get("scanning.pathScanTimeoutMs");
		},
		get autoWatcherEnabled() {
			return systemSettingsStore.get("scanning.autoWatcherEnabled");
		},
		get autoWatcherDelaySeconds() {
			return systemSettingsStore.get("scanning.autoWatcherDelaySeconds");
		},
		get autoWatcherCooldownSeconds() {
			return systemSettingsStore.get("scanning.autoWatcherCooldownSeconds");
		},

		get watcherFallbackIntervalMinutes() {
			return systemSettingsStore.get("scanning.watcherFallbackIntervalMinutes");
		},
		get scheduledScanIntervalHours() {
			return systemSettingsStore.get("scanning.scheduledScanIntervalHours");
		},
		get concurrency() {
			return systemSettingsStore.get("scanning.concurrency");
		},
		get ffprobeConcurrency() {
			return systemSettingsStore.get("scanning.ffprobeConcurrency");
		},
	},

	/** Chapter-derived markers: configurable per-language keyword lists */
	markers: {
		get introKeywords() {
			return systemSettingsStore.get("markers.introKeywords");
		},
		get creditsKeywords() {
			return systemSettingsStore.get("markers.creditsKeywords");
		},
		get recapKeywords() {
			return systemSettingsStore.get("markers.recapKeywords");
		},
	},

	/** Collections Configuration */
	collections: {
		get minimalToShow() {
			return systemSettingsStore.get("collections.minimalToShow");
		},
	},

	/** Metadata Aggregation */
	metadata: {
		get ratingAggregation() {
			return systemSettingsStore.get("metadata.ratingAggregation");
		},
	},
};

import { join } from "node:path";
import type { ProfilePreferenceDefaults } from "@reelvault/sdk/common";
import { profileDefaultPreferences } from "@/config/profile-default-preferences.config";
import { DAY, serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";

const paths = {
	...serverConstants.paths,
	/** Filesystem Paths Configuration (Dynamic runtime overrides) */
	get transcodes() {
		return systemSettingsStore.get("paths.transcodes");
	},
	get downloads() {
		return systemSettingsStore.get("paths.downloads");
	},
	get backups() {
		return systemSettingsStore.get("paths.backups");
	},
	get logsRetentionDays() {
		return systemSettingsStore.get("system.logs.retentionDays") || 7;
	},
	get imageTmp(): string {
		return join(paths.images, ".tmp");
	},
	get transcodeTmp(): string {
		return join(paths.transcodes, ".tmp");
	},
};

/** Runtime settings for the application platform: paths, database, logs, auth, API and network. */
export const platformConfig = {
	paths,

	/** Runtime logging (level applied live by the settings side effect). */
	logs: {
		get level() {
			return systemSettingsStore.get("system.logs.level");
		},
	},

	/** Database Runtime Retention */
	database: {
		...serverConstants.database,
		get operationRetentionMs() {
			const days = systemSettingsStore.get("system.database.operationRetentionDays") || 7;

			return days * DAY;
		},
		get watchedHistoryRetentionDays() {
			return systemSettingsStore.get("system.database.watchedHistoryRetentionDays");
		},
		get auditRetentionDays() {
			return systemSettingsStore.get("system.database.auditRetentionDays");
		},
		get backupRetentionCount() {
			return systemSettingsStore.get("system.database.backupRetentionCount");
		},
	},

	/** Session cookie Max-Age override (better-auth snapshot: restart to apply). */
	session: {
		get lifetimeDays() {
			return systemSettingsStore.get("auth.sessionLifetimeDays");
		},
	},

	/** Admin analytics look-back (the dashboard's "all" view) */
	analytics: {
		get windowDays() {
			return systemSettingsStore.get("system.analytics.windowDays");
		},

		get minPlaySeconds() {
			return systemSettingsStore.get("system.analytics.minPlaySeconds");
		},
	},

	/** API Pagination */
	api: {
		...serverConstants.api,
		rateLimit: {
			...serverConstants.api.rateLimit,
			get globalMax() {
				return systemSettingsStore.get("network.rateLimit.globalMax");
			},
			get routeMultiplier() {
				return systemSettingsStore.get("network.rateLimit.routeMultiplier");
			},
		},
		pagination: {
			...serverConstants.api.pagination,
			get defaultLimit() {
				return systemSettingsStore.get("api.pagination.defaultLimit");
			},
		},
	},

	/** User Profiles Default Preferences */
	profiles: {
		get maxProfilesPerUser(): number {
			return systemSettingsStore.get("profiles.maxProfilesPerUser");
		},
		get defaultPreferences(): ProfilePreferenceDefaults {
			return profileDefaultPreferences();
		},
	},

	/** Network & Allowed Origins */
	network: {
		...serverConstants.network,
		get allowedOrigins(): string[] {
			return systemSettingsStore.get("network.allowedOrigins");
		},
		get trustLocalNetworks(): boolean {
			return systemSettingsStore.get("network.trustLocalNetworks");
		},
	},

	shutdown: serverConstants.shutdown,
	security: serverConstants.security,
	compression: serverConstants.compression,

	auth: {
		...serverConstants.auth,
		get enforceTwoFactor() {
			return systemSettingsStore.get("auth.enforceTwoFactor");
		},
		get loginAccountMaxAttempts() {
			return systemSettingsStore.get("auth.rateLimit.loginAccountMaxAttempts");
		},
	},
};

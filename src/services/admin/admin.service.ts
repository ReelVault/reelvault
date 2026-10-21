import type {
	AdminCacheStats,
	AdminDashboardViewResponse,
	AdminStats,
	PluginAdminStatus,
	PluginBulkStateBody,
	PluginBulkStateResult,
	PluginConfigExport,
	ResetPluginConfigBody,
	UpdatePluginUiSettingsBody,
} from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { imageMaintenanceService, type PurgeOptimizedCacheResult } from "@/modules/images/image-maintenance.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { pluginAdminService } from "@/services/plugins/plugin-admin.service";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { cacheRegistrySnapshot } from "@/utils/memory-cache/cache-registry.registry";
import { runSafely } from "@/utils/safe-execute.utils";
import { dashboardView, resourceSettings } from "./dashboard/dashboard.service";
import { computeStats, measureDiskCaches } from "./dashboard/stats.service";
import { browseFilesystem } from "./filesystem/filesystem.service";
import {
	getMetadataProviderConfigurations,
	reorderMetadataProviderConfigurations,
	updateMetadataProviderConfiguration,
} from "./metadata-providers/metadata-providers.service";
import {
	exportPluginConfig,
	getPluginConfig,
	importPluginConfig,
	resetPluginConfig,
	updatePluginConfig,
} from "./plugins/plugin-config.service";
import {
	changePluginStatus,
	getPluginStatus,
	reloadAllPlugins,
	setPluginCspEnabled,
	setPluginPinned,
	setPluginsEnabled,
} from "./plugins/plugin-state.service";
import { getPluginUiSettings, resetPluginUiSettings, updatePluginUiSettings } from "./plugins/plugin-ui.service";
import { systemSettingsService } from "./system-settings.service";

// Full-table COUNT/SUM triple (media_files/metadata/markers) — cheap data that
// only moves on scans and playback, so a poll every few seconds would just
// re-run the aggregate for nothing.
const STATS_CACHE_TTL_MS = 30_000;
const DISK_STATS_CACHE_TTL_MS = MINUTE;

class AdminService {
	readonly serviceName = "AdminService";
	readonly logger = createLogger("AdminService");

	private readonly statsCache = new MemoryCache<AdminStats>({ ttlMs: STATS_CACHE_TTL_MS, maxSize: 1, name: "admin-stats" });
	private readonly diskStatsCache = new MemoryCache<AdminCacheStats["disk"]>({
		ttlMs: DISK_STATS_CACHE_TTL_MS,
		maxSize: 1,
		name: "admin-cache-disk",
	});

	async stats(): Promise<AdminStats> {
		return await this.statsCache.getOrSet("stats", () => computeStats());
	}

	async cacheStats(): Promise<AdminCacheStats> {
		const disk = await this.diskStatsCache.getOrSet("disk", () => measureDiskCaches());

		return { timestamp: new Date().toISOString(), disk, memory: cacheRegistrySnapshot() };
	}

	/** Deletes the optimized image copies; the disk stats are measured again on the next read. */
	async purgeImageCache(): Promise<PurgeOptimizedCacheResult> {
		return await runSafely(this, "purgeImageCache", async () => {
			const result = await imageMaintenanceService.purgeOptimizedCache();
			this.diskStatsCache.clear();

			return result;
		});
	}

	async dashboard() {
		return await runSafely(this, "dashboard", async () => {
			const [stats, providers, plugins, settings] = await Promise.all([
				this.stats(),
				this.getMetadataProviderConfigurations(),
				this.plugins(),
				systemSettingsService.getAll(),
			]);

			return { stats, resources: resourceSettings(), providers, plugins, settings };
		});
	}

	dashboardView(): Promise<AdminDashboardViewResponse> {
		return dashboardView(this, () => this.stats());
	}

	pluginConfig(pluginId: string) {
		return getPluginConfig(this, pluginId);
	}

	updatePluginConfig(pluginId: string, updatedConfig: Record<string, unknown>, context?: AdminAuditContext) {
		return updatePluginConfig(this, pluginId, updatedConfig, context);
	}

	resetPluginConfig(pluginId: string, body: ResetPluginConfigBody, context?: AdminAuditContext) {
		return resetPluginConfig(this, pluginId, body.keys, context);
	}

	exportPluginConfig(pluginId: string) {
		return exportPluginConfig(this, pluginId);
	}

	importPluginConfig(pluginId: string, body: PluginConfigExport, context?: AdminAuditContext) {
		return importPluginConfig(this, pluginId, body, context);
	}

	setPluginsEnabled(body: PluginBulkStateBody, context?: AdminAuditContext): Promise<PluginBulkStateResult> {
		return setPluginsEnabled(this, body, context);
	}

	setPluginPinned(pluginId: string, pinned: boolean, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return setPluginPinned(this, pluginId, pinned, context);
	}

	setPluginCspEnabled(pluginId: string, enabled: boolean, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return setPluginCspEnabled(this, pluginId, enabled, context);
	}

	plugins(): Promise<PluginAdminStatus[]> {
		return pluginAdminService.list();
	}

	reloadPlugins(context?: AdminAuditContext): Promise<PluginAdminStatus[]> {
		return reloadAllPlugins(this, context);
	}

	getPlugin(pluginId: string): Promise<PluginAdminStatus> {
		return getPluginStatus(pluginId);
	}

	enablePlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return changePluginStatus(this, "enable", pluginId, context);
	}

	disablePlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return changePluginStatus(this, "disable", pluginId, context);
	}

	reloadPlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return changePluginStatus(this, "reload", pluginId, context);
	}

	getPluginUiSettings(pluginId: string) {
		return getPluginUiSettings(pluginId);
	}

	updatePluginUiSettings(pluginId: string, body: UpdatePluginUiSettingsBody, context?: AdminAuditContext) {
		return updatePluginUiSettings(this, pluginId, body, context);
	}

	resetPluginUiSettings(pluginId: string, context?: AdminAuditContext) {
		return resetPluginUiSettings(this, pluginId, context);
	}

	getMetadataProviderConfigurations() {
		return getMetadataProviderConfigurations();
	}

	updateMetadataProviderConfiguration(providerId: string, values: { priority?: number; enabled?: boolean }, context?: AdminAuditContext) {
		return updateMetadataProviderConfiguration(this, providerId, values, context);
	}

	reorderMetadataProviderConfigurations(providerIds: string[], context?: AdminAuditContext) {
		return reorderMetadataProviderConfigurations(this, providerIds, context);
	}

	browseFilesystem(requestedPath?: string) {
		return browseFilesystem(requestedPath);
	}
}

export const adminService = new AdminService();

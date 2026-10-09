import { readdir, stat } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import type {
	AdminCacheStats,
	AdminDashboardViewResponse,
	AdminFilesystemBrowse,
	AdminStats,
	MetadataProviderConfiguration,
	PluginAdminStatus,
	PluginBulkStateBody,
	PluginBulkStateResult,
	PluginConfigDetails,
	PluginConfigExport,
	PluginUiSettings,
	ResetPluginConfigBody,
	UpdatePluginUiSettingsBody,
} from "@reelvault/sdk/common";
import { librariesService } from "@/application/libraries/libraries.service";
import { pluginAdminService } from "@/application/plugin-admin.service";
import { updateCheckService } from "@/application/updates/update-check.service";
import { describeUpdateEnvironment } from "@/application/updates/update-environment";
import { updateInstallService } from "@/application/updates/update-install.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { adminStatsRepository } from "@/database/repositories/admin-stats.repository";
import { imageMaintenanceService, type PurgeOptimizedCacheResult } from "@/modules/images/image-maintenance.service";
import { sessionLifecycleService } from "@/modules/streaming/sessions/session-lifecycle.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginUiSettingsService } from "@/plugins/lifecycle/plugin-ui-settings.service";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { resourceAllocator } from "@/system/resource-allocator";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DomainError, errorMessage, NotFoundError, ValidationError } from "@/utils/errors";
import { cacheRegistrySnapshot, MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { measureDirectory } from "@/utils/server-data.utils";
import { isNonEmptyString } from "@/utils/type.utils";
import { SERVER_VERSION } from "@/version";
import { resolveWebVersion } from "@/web/web-dist";
import { workerService } from "@/workers/worker.service";
import { adminAuditService, recordAuditSafe } from "./admin-audit.service";
import { adminLogsService } from "./admin-logs.service";
import { systemSettingsService } from "./system-settings.service";

// Full-table COUNT/SUM triple (media_files/metadata/markers) — cheap data that
// only moves on scans and playback, so a poll every few seconds would just
// re-run the aggregate for nothing.
const STATS_CACHE_TTL_MS = 30_000;
const DISK_STATS_CACHE_TTL_MS = MINUTE;

/** Compact audit view of a plugin's UI switches: master flag plus the hidden keys. */
function summarizeUiSettings(settings: PluginUiSettings): { enabled: boolean; disabledKeys: string[] } {
	return { enabled: settings.enabled, disabledKeys: settings.contributions.filter((item) => !item.enabled).map((item) => item.key) };
}

class AdminService extends BaseService {
	private readonly statsCache = new MemoryCache<AdminStats>({ ttlMs: STATS_CACHE_TTL_MS, maxSize: 1, name: "admin-stats" });
	private readonly diskStatsCache = new MemoryCache<AdminCacheStats["disk"]>({
		ttlMs: DISK_STATS_CACHE_TTL_MS,
		maxSize: 1,
		name: "admin-cache-disk",
	});

	constructor() {
		super("AdminService");
	}

	async stats(): Promise<AdminStats> {
		return await this.statsCache.getOrSet("stats", () => this.computeStats());
	}

	private async computeStats(): Promise<AdminStats> {
		const activeSessions = sessionLifecycleService.getActiveSessions();
		const [workerStatsList, mediaRow, metadataRow, markersRow] = await Promise.all([
			workerService.getStats().catch(() => []),
			adminStatsRepository.getMediaStats(),
			adminStatsRepository.getMetadataStats(),
			adminStatsRepository.getMarkerStats(),
		]);

		const workers = workerStatsList.reduce(
			(acc, s) => {
				acc.active += s.active;
				acc.waiting += s.waiting;
				acc.completed += s.completed;
				acc.failed += s.failed;

				return acc;
			},
			{ active: 0, waiting: 0, completed: 0, failed: 0 },
		);

		const systemSnapshot = resourceAllocator.getCurrentSnapshot();

		return {
			uptime: process.uptime(),
			memory: { ...process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit },
			...(systemSnapshot
				? {
						systemMemory: {
							usedMb: systemSnapshot.memory.usedMb,
							totalMb: systemSnapshot.memory.totalMb,
							percent: systemSnapshot.memory.percent,
						},
						pressure: systemSnapshot.pressure,
					}
				: {}),
			streaming: { activeSessions },
			timestamp: new Date().toISOString(),
			workers,
			media: {
				totalFiles: mediaRow?.totalFiles ?? 0,
				totalSize: mediaRow?.totalSize ?? 0,
				moviesCount: mediaRow?.moviesCount ?? 0,
				episodesCount: mediaRow?.episodesCount ?? 0,
				withQualityCount: mediaRow?.withQualityCount ?? 0,
			},
			metadata: {
				totalCount: metadataRow?.totalCount ?? 0,
				moviesCount: metadataRow?.moviesCount ?? 0,
				tvShowsCount: metadataRow?.tvShowsCount ?? 0,
				lowConfidenceCount: metadataRow?.lowConfidenceCount ?? 0,
				missingTranslationCount: metadataRow?.missingTranslationCount ?? 0,
			},
			markers: {
				totalCount: markersRow?.totalCount ?? 0,
				introsCount: markersRow?.introsCount ?? 0,
				creditsCount: markersRow?.creditsCount ?? 0,
				highlightsCount: markersRow?.highlightsCount ?? 0,
				fromPluginsCount: markersRow?.fromPluginsCount ?? 0,
			},
		};
	}

	async cacheStats(): Promise<AdminCacheStats> {
		const disk = await this.diskStatsCache.getOrSet("disk", async () => {
			const [transcodes, images, subtitles] = await Promise.all([
				measureDirectory(serverConfig.paths.transcodes),
				measureDirectory(serverConfig.paths.images),
				measureDirectory(serverConfig.paths.subtitles),
			]);

			return { transcodes, images, subtitles };
		});

		return { timestamp: new Date().toISOString(), disk, memory: cacheRegistrySnapshot() };
	}

	/** Deletes the optimized image copies; the disk stats are measured again on the next read. */
	async purgeImageCache(): Promise<PurgeOptimizedCacheResult> {
		return await this.safeExecute("purgeImageCache", async () => {
			const result = await imageMaintenanceService.purgeOptimizedCache();
			this.diskStatsCache.clear();

			return result;
		});
	}

	async dashboard(): Promise<{
		stats: AdminStats;
		resources: {
			monitoringEnabled: boolean;
			memoryThresholdPercent: number;
			diskThresholdPercent: number;
			enableDynamicThrottling: boolean;
		};
		providers: MetadataProviderConfiguration[];
		plugins: PluginAdminStatus[];
		settings: Awaited<ReturnType<typeof systemSettingsService.getAll>>;
	}> {
		return await this.safeExecute("dashboard", async () => {
			const [stats, providers, pluginList, settings] = await Promise.all([
				this.stats(),
				this.getMetadataProviderConfigurations(),
				this.plugins(),
				systemSettingsService.getAll(),
			]);

			return {
				stats,
				resources: {
					monitoringEnabled: serverConfig.resources.monitoringEnabled,
					memoryThresholdPercent: serverConfig.resources.memoryThresholdPercent,
					diskThresholdPercent: serverConfig.resources.diskThresholdPercent,
					enableDynamicThrottling: serverConfig.resources.enableDynamicThrottling,
				},
				providers,
				plugins: pluginList,
				settings,
			};
		});
	}

	/**
	 * Composite view for the admin dashboard page: the six calls the client
	 * used to fan out (stats, libraries, worker operations, audit feed, error
	 * logs, update status) run here in parallel behind one request.
	 */
	async dashboardView(): Promise<AdminDashboardViewResponse> {
		return await this.safeExecute("dashboardView", async () => {
			await updateCheckService.checkLatest(false);
			const updateState = updateCheckService.getState();

			const [stats, libraries, operations, audit, logs] = await Promise.all([
				this.stats(),
				librariesService.getAll({ limit: 50 }),
				workerService.listOperations({ page: 1, limit: 8 }),
				adminAuditService.getAll({ page: 1, limit: 6 }),
				adminLogsService.getLogs({ level: "warn,error,fatal", limit: 6 }),
			]);

			const installType = updateInstallService.getInstallType();

			return {
				stats,
				libraries: libraries.data,
				operations,
				audit,
				logs,
				update: {
					serverVersion: SERVER_VERSION,
					webVersion: resolveWebVersion(),
					...updateState,
					installType,
					flavor: installType === "archive" ? updateInstallService.getFlavor() : null,
					environment: describeUpdateEnvironment(),
					serverRollbackAvailable: updateInstallService.isRollbackAvailable("server"),
					webRollbackAvailable: updateInstallService.isRollbackAvailable("web"),
					serverLastErrorCode: updateInstallService.getLastError("server") ?? updateState.serverLastError,
					webLastErrorCode: updateInstallService.getLastError("web") ?? updateState.webLastError,
					job: updateInstallService.getJob(),
				},
			};
		});
	}

	async pluginConfig(pluginId: string): Promise<PluginConfigDetails> {
		return await this.safeExecute("pluginConfig", async () => await pluginManager.getPluginConfigDetails(pluginId));
	}

	async updatePluginConfig(
		pluginId: string,
		updatedConfig: Record<string, unknown>,
		context?: AdminAuditContext,
	): Promise<PluginConfigDetails> {
		return await this.safeExecute("updatePluginConfig", async () => {
			const before = await pluginManager.getPluginConfigDetails(pluginId);
			const after = await pluginManager.savePluginConfig(pluginId, updatedConfig);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "plugin_config",
					resourceId: pluginId,
					before: before.config,
					after: after.config,
					context,
				},
				this.logger,
			);

			return after;
		});
	}

	/** Enables or disables several plugins. Each one is attempted on its own, so one failure does not stop the rest. */
	async setPluginsEnabled(body: PluginBulkStateBody, context?: AdminAuditContext): Promise<PluginBulkStateResult> {
		return await this.safeExecute("setPluginsEnabled", async () => {
			const results: PluginBulkStateResult["results"] = [];
			for (const pluginId of body.pluginIds) {
				try {
					await pluginManager.setEnabled(pluginId, body.enabled);
					results.push({ pluginId, ok: true });
				} catch (error) {
					results.push({
						pluginId,
						ok: false,
						error: errorMessage(error),
						...(error instanceof DomainError ? { errorCode: error.code } : {}),
					});
				}
			}

			recordAuditSafe(
				{
					action: "update",
					resourceType: "plugins",
					after: {
						action: body.enabled ? "bulk_enable" : "bulk_disable",
						pluginIds: body.pluginIds,
						failed: results.filter((result) => !result.ok).map((result) => result.pluginId),
					},
					context,
				},
				this.logger,
			);

			return { results };
		});
	}

	/** Admin choice: keep the installed version (`pinned: true`) or allow catalog updates again. */
	async setPluginPinned(pluginId: string, pinned: boolean, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return await this.safeExecute("setPluginPinned", async () => {
			const before = await pluginManager.getPackageDetails(pluginId);
			await pluginManager.setPluginPinned(pluginId, pinned);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "plugin",
					resourceId: pluginId,
					before: { pinned: before.pinned === true },
					after: { pinned },
					context,
				},
				this.logger,
			);

			const status = await pluginAdminService.get(pluginId);
			if (!status) throw new NotFoundError(`Plugin not found: ${pluginId}`);

			return status;
		});
	}

	/** Admin choice: allow (`enabled: true`) or refuse the CSP sources the plugin's manifest declares. */
	async setPluginCspEnabled(pluginId: string, enabled: boolean, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return await this.safeExecute("setPluginCspEnabled", async () => {
			const before = await pluginManager.getPackageDetails(pluginId);
			await pluginManager.setPluginCspDisabled(pluginId, !enabled);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "plugin",
					resourceId: pluginId,
					before: { cspDisabled: before.cspDisabled === true },
					after: { cspDisabled: !enabled },
					context,
				},
				this.logger,
			);

			const status = await pluginAdminService.get(pluginId);
			if (!status) throw new NotFoundError(`Plugin not found: ${pluginId}`);

			return status;
		});
	}

	async resetPluginConfig(pluginId: string, body: ResetPluginConfigBody, context?: AdminAuditContext): Promise<PluginConfigDetails> {
		return await this.safeExecute("resetPluginConfig", async () => {
			const before = await pluginManager.getPluginConfigDetails(pluginId);
			const after = await pluginManager.resetPluginConfig(pluginId, body.keys);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "plugin_config",
					resourceId: pluginId,
					before: before.config,
					after: after.config,
					context,
				},
				this.logger,
			);

			return after;
		});
	}

	/** The configuration an administrator can carry to another installation: every non-secret value. */
	async exportPluginConfig(pluginId: string): Promise<PluginConfigExport> {
		return await this.safeExecute("exportPluginConfig", async () => {
			const details = await pluginManager.getPluginConfigDetails(pluginId);

			return { format: "reelvault.plugin-config", formatVersion: 1, pluginId: details.id, values: details.config };
		});
	}

	/**
	 * Applies an exported configuration. Secret fields in the file are dropped, so an import can
	 * never overwrite a stored credential; everything else goes through the normal config validation.
	 */
	async importPluginConfig(pluginId: string, body: PluginConfigExport, context?: AdminAuditContext): Promise<PluginConfigDetails> {
		return await this.safeExecute("importPluginConfig", async () => {
			if (body.pluginId !== pluginId) {
				throw new ValidationError("The configuration file belongs to another plugin", { code: "plugin.config_import_mismatch" });
			}

			const before = await pluginManager.getPluginConfigDetails(pluginId);
			const secretFields = new Set(before.fields.filter((field) => field.type === "secret").map((field) => field.name));
			const values = Object.fromEntries(Object.entries(body.values).filter(([key]) => !secretFields.has(key)));
			const after = await pluginManager.savePluginConfig(pluginId, values);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "plugin_config",
					resourceId: pluginId,
					before: before.config,
					after: after.config,
					context,
				},
				this.logger,
			);

			return after;
		});
	}

	plugins(): Promise<PluginAdminStatus[]> {
		return pluginAdminService.list();
	}

	async reloadPlugins(context?: AdminAuditContext): Promise<PluginAdminStatus[]> {
		await pluginManager.reloadAll();
		const result = await pluginAdminService.list();
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugins",
				after: { action: "reload_all", total: result.length },
				context,
			},
			this.logger,
		);

		return result;
	}

	async getPlugin(pluginId: string): Promise<PluginAdminStatus> {
		const plugin = await pluginAdminService.get(pluginId);
		if (!plugin) throw new NotFoundError(`Plugin not found: ${pluginId}`);

		return plugin;
	}

	private async changePluginStatus(
		action: "enable" | "disable" | "reload",
		pluginId: string,
		context?: AdminAuditContext,
	): Promise<PluginAdminStatus> {
		const operations: Record<"enable" | "disable" | "reload", (id: string) => Promise<PluginAdminStatus | undefined>> = {
			enable: (id) => pluginAdminService.enable(id),
			disable: (id) => pluginAdminService.disable(id),
			reload: (id) => pluginAdminService.reload(id),
		};
		const plugin = await operations[action](pluginId);
		if (!plugin) throw new NotFoundError(`Plugin not found: ${pluginId}`);

		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin",
				resourceId: pluginId,
				after: { status: action === "reload" ? "reloaded" : action, plugin },
				context,
			},
			this.logger,
		);

		return plugin;
	}

	getPluginUiSettings(pluginId: string): Promise<PluginUiSettings> {
		return pluginUiSettingsService.get(pluginId);
	}

	async updatePluginUiSettings(pluginId: string, body: UpdatePluginUiSettingsBody, context?: AdminAuditContext): Promise<PluginUiSettings> {
		const before = await pluginUiSettingsService.get(pluginId);
		const after = await pluginUiSettingsService.update(pluginId, body);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_ui_settings",
				resourceId: pluginId,
				before: summarizeUiSettings(before),
				after: summarizeUiSettings(after),
				context,
			},
			this.logger,
		);

		return after;
	}

	async resetPluginUiSettings(pluginId: string, context?: AdminAuditContext): Promise<PluginUiSettings> {
		const before = await pluginUiSettingsService.get(pluginId);
		await pluginUiSettingsService.reset(pluginId);
		const after = await pluginUiSettingsService.get(pluginId);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_ui_settings",
				resourceId: pluginId,
				before: summarizeUiSettings(before),
				after: summarizeUiSettings(after),
				context,
			},
			this.logger,
		);

		return after;
	}

	enablePlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return this.changePluginStatus("enable", pluginId, context);
	}

	disablePlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return this.changePluginStatus("disable", pluginId, context);
	}

	reloadPlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginAdminStatus> {
		return this.changePluginStatus("reload", pluginId, context);
	}

	async getMetadataProviderConfigurations(): Promise<MetadataProviderConfiguration[]> {
		return await providerService.getConfigurations();
	}

	async updateMetadataProviderConfiguration(
		providerId: string,
		values: { priority?: number; enabled?: boolean },
		context?: AdminAuditContext,
	): Promise<MetadataProviderConfiguration> {
		const before = (await providerService.getConfigurations()).find((provider) => provider.id === providerId);
		if (!before) throw new NotFoundError(`Metadata provider not found: ${providerId}`);

		const after = await providerService.updateConfiguration(providerId, values);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "metadata_provider_configuration",
				resourceId: providerId,
				before,
				after,
				context,
			},
			this.logger,
		);

		return after;
	}

	async reorderMetadataProviderConfigurations(
		providerIds: string[],
		context?: AdminAuditContext,
	): Promise<MetadataProviderConfiguration[]> {
		const before = await providerService.getConfigurations();
		const after = await providerService.reorderConfigurations(providerIds);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "metadata_provider_configuration_order",
				resourceId: "order",
				before,
				after,
				context,
			},
			this.logger,
		);

		return after;
	}

	async browseFilesystem(requestedPath?: string): Promise<AdminFilesystemBrowse> {
		const targetPath = isNonEmptyString(requestedPath) ? PathUtils.resolve(requestedPath.trim()) : "/";

		try {
			const stats = await stat(targetPath);
			if (!stats.isDirectory()) {
				return {
					currentPath: targetPath,
					parentPath: targetPath === "/" ? null : PathUtils.getDirName(targetPath),
					directories: [],
					exists: false,
				};
			}

			const entries = await readdir(targetPath, { withFileTypes: true });
			const directories: Array<{ name: string; path: string }> = [];
			const symlinkEntries: string[] = [];

			for (const entry of entries) {
				if (entry.name === "." || entry.name === "..") continue;

				if (entry.isDirectory()) {
					directories.push({
						name: entry.name,
						path: PathUtils.join(targetPath, entry.name),
					});
				} else if (entry.isSymbolicLink()) {
					symlinkEntries.push(entry.name);
				}
			}

			await PromiseUtils.mapConcurrent(symlinkEntries, systemResourcesService.getIoConcurrency(), async (name) => {
				try {
					const linkStats = await stat(PathUtils.join(targetPath, name));
					if (linkStats.isDirectory()) {
						directories.push({
							name,
							path: PathUtils.join(targetPath, name),
						});
					}
				} catch {
					// Ignore broken symlinks
				}
			});

			directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

			const parentPath = targetPath === "/" ? null : PathUtils.getDirName(targetPath);

			return {
				currentPath: targetPath,
				parentPath,
				directories,
				exists: true,
			};
		} catch {
			return {
				currentPath: targetPath,
				parentPath: targetPath === "/" ? null : PathUtils.getDirName(targetPath),
				directories: [],
				exists: false,
			};
		}
	}
}

export const adminService = new AdminService();

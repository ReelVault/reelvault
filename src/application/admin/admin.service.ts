import { readdir, stat } from "node:fs/promises";
import { getHeapStatistics } from "node:v8";
import type {
	AdminCacheStats,
	AdminDashboardViewResponse,
	AdminFilesystemBrowse,
	AdminStats,
	MetadataProviderConfiguration,
	PluginConfigDetails,
	PluginRuntimeStatus,
} from "@reelvault/sdk/common";
import { librariesService } from "@/application/libraries/libraries.service";
import { pluginAdminService } from "@/application/plugin-admin.service";
import { updateCheckService } from "@/application/updates/update-check.service";
import { updateInstallService } from "@/application/updates/update-install.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { adminStatsRepository } from "@/database/repositories/admin-stats.repository";
import { sessionLifecycleService } from "@/modules/streaming/sessions/session-lifecycle.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { resourceAllocator } from "@/system/resource-allocator";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
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

	async dashboard(): Promise<{
		stats: AdminStats;
		resources: {
			monitoringEnabled: boolean;
			memoryThresholdPercent: number;
			diskThresholdPercent: number;
			enableDynamicThrottling: boolean;
		};
		providers: MetadataProviderConfiguration[];
		plugins: PluginRuntimeStatus[];
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
					installType: updateInstallService.getInstallType(),
					flavor: updateInstallService.getInstallType() === "archive" ? updateInstallService.getFlavor() : null,
					serverRollbackAvailable: updateInstallService.isRollbackAvailable("server"),
					webRollbackAvailable: updateInstallService.isRollbackAvailable("web"),
					serverLastError: updateInstallService.getLastError("server") ?? updateState.serverLastError,
					webLastError: updateInstallService.getLastError("web") ?? updateState.webLastError,
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

	plugins(): Promise<PluginRuntimeStatus[]> {
		return Promise.resolve(pluginManager.getStatus());
	}

	async reloadPlugins(context?: AdminAuditContext): Promise<PluginRuntimeStatus[]> {
		const result = await pluginManager.reloadAll().then(() => pluginManager.getStatus());
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

	getPlugin(pluginId: string): PluginRuntimeStatus {
		const plugin = pluginAdminService.get(pluginId);
		if (!plugin) throw new NotFoundError(`Plugin not found: ${pluginId}`);

		return plugin;
	}

	private async changePluginStatus(
		action: "enable" | "disable" | "reload",
		pluginId: string,
		context?: AdminAuditContext,
	): Promise<PluginRuntimeStatus> {
		const operations: Record<"enable" | "disable" | "reload", (id: string) => Promise<PluginRuntimeStatus | undefined>> = {
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

	enablePlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginRuntimeStatus> {
		return this.changePluginStatus("enable", pluginId, context);
	}

	disablePlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginRuntimeStatus> {
		return this.changePluginStatus("disable", pluginId, context);
	}

	reloadPlugin(pluginId: string, context?: AdminAuditContext): Promise<PluginRuntimeStatus> {
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

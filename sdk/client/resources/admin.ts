import type {
	AdminAnalytics,
	AdminAuditPage,
	AdminCacheStats,
	AdminCreateUser,
	AdminCreateUserProfile,
	AdminDatabaseBackup,
	AdminDownloadsResponse,
	AdminFfmpegCapabilities,
	AdminFilesystemBrowse,
	AdminLiveActivityResponse,
	AdminLogFileInfo,
	AdminLogsPage,
	AdminProcessesResponse,
	AdminResourcesResponse,
	AdminSetUserPassword,
	AdminStats,
	AdminUser,
	AdminUserProfile,
	AdminUsersPage,
	InstallCatalogPluginBody,
	InstallCatalogPluginResponse,
	MetadataProviderConfiguration,
	OperationQueuedResponse,
	PluginCatalogEntry,
	PluginConfigDetails,
	PluginRepository,
	PluginRuntimeStatus,
	PurgeWorkerHistoryOptions,
	PurgeWorkerHistoryResponse,
	ResetSystemSettings,
	SystemSettingsGrouped,
	TaskTrigger,
	UpdatePluginRepositoryBody,
	UpdateSystemSettings,
	WorkerCategory,
	WorkerCategoryRunResponse,
	WorkerJob,
	WorkerOperation,
	WorkerOperationJobsResponse,
	WorkerSummary,
} from "@sdk/common";
import type { PaginatedResponse } from "@sdk/common/pagination";
import type { ProfilePreferences, UpdateProfilePreferences } from "@sdk/common/profile-preferences.types";
import type { RemoteAccessDiagnostics } from "@sdk/common/remote-access";

import { BaseResource } from "../core/base-client";
import { buildUrl } from "../core/utils";

export class AdminClient extends BaseResource {
	getRemoteAccessDiagnostics(): Promise<RemoteAccessDiagnostics> {
		return this._get("/admin/network/remote-access");
	}

	getSystemSettings(): Promise<SystemSettingsGrouped> {
		return this._get("/admin/settings");
	}

	updateSystemSettings(body: UpdateSystemSettings): Promise<SystemSettingsGrouped> {
		return this._patch("/admin/settings", { body });
	}

	resetSystemSettings(body?: ResetSystemSettings): Promise<SystemSettingsGrouped> {
		return this._post("/admin/settings/reset", { body });
	}

	// ─── Workers & Schedules ──────────────────────────────────────────────────
	getWorkers(): Promise<WorkerSummary[]> {
		return this._get("/admin/workers");
	}

	runWorker(workerId: string, data?: unknown): Promise<{ success: boolean; jobId: string; operationId?: string }> {
		return this._post(`/admin/workers/${workerId}/run`, { body: data });
	}

	runWorkerCategory(category: WorkerCategory): Promise<WorkerCategoryRunResponse> {
		return this._post(`/admin/workers/categories/${category}/run`, { body: undefined });
	}

	cancelWorker(workerId: string): Promise<{ success: boolean; cancelledCount: number }> {
		return this._post(`/admin/workers/${workerId}/cancel`, { body: undefined });
	}

	cancelAllWorkers(): Promise<{ success: boolean; cancelledCount: number }> {
		return this._post("/admin/workers/cancel-all", { body: undefined });
	}

	resumeWorkerOperation(operationId: string): Promise<{ success: boolean; resumed: number }> {
		return this._post(`/admin/workers/operations/${operationId}/resume`, { body: undefined });
	}

	updateWorkerTriggers(workerId: string, triggers: TaskTrigger[]): Promise<TaskTrigger[]> {
		return this._put(`/admin/workers/${workerId}/triggers`, { body: { triggers } });
	}

	purgeWorkerHistory(options?: PurgeWorkerHistoryOptions): Promise<PurgeWorkerHistoryResponse> {
		return this._post("/admin/workers/purge-history", { body: options ?? {} });
	}

	// ─── Worker Jobs ──────────────────────────────────────────────────────────
	getWorkerJobs(query?: { limit?: number; workerId?: string }): Promise<WorkerJob[]> {
		return this._get("/admin/workers/jobs", { query });
	}

	getWorkerJob(jobId: string): Promise<WorkerJob> {
		return this._get(`/admin/workers/jobs/${jobId}`);
	}

	cancelWorkerJob(jobId: string): Promise<{ success: boolean }> {
		return this._post(`/admin/workers/jobs/${jobId}/cancel`, { body: undefined });
	}

	deleteWorkerJob(jobId: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/workers/jobs/${jobId}`);
	}

	// ─── Worker Operations (Batches) ──────────────────────────────────────────
	getWorkerOperations(query?: {
		page?: number | undefined;
		limit?: number | undefined;
		status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "active" | undefined;
	}): Promise<PaginatedResponse<WorkerOperation>> {
		return this._get("/admin/workers/operations", { query });
	}

	getWorkerOperation(operationId: string): Promise<WorkerOperation> {
		return this._get(`/admin/workers/operations/${operationId}`);
	}

	getWorkerOperationJobs(
		operationId: string,
		query?: {
			page?: number | undefined;
			limit?: number | undefined;
			status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
			search?: string | undefined;
		},
	): Promise<WorkerOperationJobsResponse> {
		return this._get(`/admin/workers/operations/${operationId}/jobs`, { query });
	}

	cancelWorkerOperation(operationId: string): Promise<{ success: boolean }> {
		return this._post(`/admin/workers/operations/${operationId}/cancel`, { body: undefined });
	}

	cancelAllWorkerOperations(): Promise<{ success: boolean; cancelledCount: number }> {
		return this._post("/admin/workers/operations/cancel-all", { body: undefined });
	}

	// ─── Background Processes ─────────────────────────────────────────────────
	getProcesses(): Promise<AdminProcessesResponse> {
		return this._get("/admin/processes");
	}

	getUsers(query?: { search?: string; page?: number; limit?: number }): Promise<AdminUsersPage> {
		return this._get("/admin/users", { query });
	}

	getUser(userId: string): Promise<AdminUser> {
		return this._get(`/admin/users/${userId}`);
	}

	getUserFull(userId: string): Promise<{ user: AdminUser; profiles: AdminUserProfile[] }> {
		return this._get(`/admin/users/${userId}/full`);
	}

	createUser(body: AdminCreateUser): Promise<AdminUser> {
		return this._post(`/admin/users`, { body });
	}

	updateUser(userId: string, body: { role?: "admin" | "user"; banned?: boolean; banReason?: string | null }): Promise<AdminUser> {
		return this._patch(`/admin/users/${userId}`, { body });
	}

	setUserPassword(userId: string, body: AdminSetUserPassword): Promise<{ success: boolean }> {
		return this._post(`/admin/users/${userId}/password`, { body });
	}

	deleteUser(userId: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/users/${userId}`);
	}

	getUserProfiles(userId: string): Promise<AdminUserProfile[]> {
		return this._get(`/admin/users/${userId}/profiles`);
	}

	createUserProfile(userId: string, body: AdminCreateUserProfile): Promise<AdminUserProfile> {
		return this._post(`/admin/users/${userId}/profiles`, { body });
	}

	updateUserProfile(
		userId: string,
		profileId: string,
		body: { name?: string; avatarUrl?: string | null; pin?: string | null },
	): Promise<AdminUserProfile> {
		return this._patch(`/admin/users/${userId}/profiles/${profileId}`, { body });
	}

	deleteUserProfile(userId: string, profileId: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/users/${userId}/profiles/${profileId}`);
	}

	getUserProfilePreferences(userId: string, profileId: string): Promise<ProfilePreferences> {
		return this._get(`/admin/users/${userId}/profiles/${profileId}/preferences`);
	}

	updateUserProfilePreferences(userId: string, profileId: string, body: UpdateProfilePreferences): Promise<ProfilePreferences> {
		return this._patch(`/admin/users/${userId}/profiles/${profileId}/preferences`, { body });
	}

	resetUserProfilePreferences(userId: string, profileId: string): Promise<ProfilePreferences> {
		return this._delete(`/admin/users/${userId}/profiles/${profileId}/preferences`);
	}

	getMetadataProviderConfigurations(): Promise<MetadataProviderConfiguration[]> {
		return this._get("/admin/providers");
	}

	updateMetadataProviderConfiguration(
		providerId: string,
		body: { priority?: number; enabled?: boolean },
	): Promise<MetadataProviderConfiguration> {
		return this._patch(`/admin/providers/${providerId}`, { body });
	}

	/** Persists provider priority order (first = highest priority). */
	reorderMetadataProviderConfigurations(providerIds: string[]): Promise<MetadataProviderConfiguration[]> {
		return this._put("/admin/providers/order", { body: { providerIds } });
	}

	getStats(): Promise<AdminStats> {
		return this._get("/admin/stats");
	}

	getCacheStats(): Promise<AdminCacheStats> {
		return this._get("/admin/cache-stats");
	}

	getDashboard(): Promise<{
		stats: AdminStats;
		resources: AdminResourcesResponse;
		providers: MetadataProviderConfiguration[];
		plugins: PluginRuntimeStatus[];
		settings: SystemSettingsGrouped;
	}> {
		return this._get("/admin/dashboard");
	}

	getAnalytics(days?: number): Promise<AdminAnalytics> {
		return this._get("/admin/analytics", { query: days ? { days } : undefined });
	}

	getLiveActivity(): Promise<AdminLiveActivityResponse> {
		return this._get("/admin/live-activity");
	}

	terminateLiveStream(sessionId: string, reason?: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/live-activity/${sessionId}`, { query: reason ? { reason } : undefined });
	}

	getResources(): Promise<AdminResourcesResponse> {
		return this._get("/admin/resources");
	}

	getFfmpegCapabilities(): Promise<AdminFfmpegCapabilities> {
		return this._get("/admin/ffmpeg-capabilities");
	}

	refreshFfmpegCapabilities(): Promise<AdminFfmpegCapabilities> {
		return this._post("/admin/ffmpeg-capabilities/refresh", { body: undefined });
	}

	getPluginConfig(pluginId: string): Promise<PluginConfigDetails> {
		return this._get(`/admin/plugins/${pluginId}/config`);
	}

	updatePluginConfig(pluginId: string, body: Record<string, unknown>): Promise<PluginConfigDetails> {
		return this._put(`/admin/plugins/${pluginId}/config`, { body });
	}

	getLogFiles(): Promise<AdminLogFileInfo[]> {
		return this._get("/admin/logs/files");
	}

	getLogs(query?: { fileId?: string; level?: string; search?: string; limit?: number; page?: number }): Promise<AdminLogsPage> {
		return this._get("/admin/logs", { query });
	}

	getAudit(query?: {
		page?: number | undefined;
		limit?: number | undefined;
		action?: "create" | "update" | "delete" | undefined;
		resourceType?: string | undefined;
		actorUserId?: string | undefined;
		ipAddress?: string | undefined;
		requestId?: string | undefined;
		from?: string | undefined;
		to?: string | undefined;
	}): Promise<AdminAuditPage> {
		return this._get("/admin/audit", { query });
	}

	downloadLogs(fileId?: string): Promise<string> {
		return this._get("/admin/logs/download", { query: fileId ? { fileId } : undefined });
	}

	deleteLogFile(fileId: string): Promise<{ success: boolean }> {
		return this._delete("/admin/logs", { query: { fileId } });
	}

	cleanupLogs(retentionDays?: number): Promise<{ scannedCount: number; deletedCount: number; freedBytes: number; retentionDays: number }> {
		return this._delete("/admin/logs/cleanup", { query: retentionDays ? { retentionDays } : undefined });
	}

	// ─── Trickplay ────────────────────────────────────────────────────────────
	getTrickplayStats(): Promise<{ total: number; withTrickplay: number; missingTrickplay: number }> {
		return this._get("/admin/trickplay/stats");
	}

	generateTrickplay(mediaFileId: string): Promise<{ enqueued: boolean; taskId: string | null }> {
		return this._post(`/admin/trickplay/generate/${mediaFileId}`, { body: undefined });
	}

	generateAllTrickplay(): Promise<{ enqueued: number }> {
		return this._post("/admin/trickplay/generate-all", { body: undefined });
	}

	deleteOrphanMetadata(): Promise<{ count: number }> {
		return this._delete("/admin/metadata/orphans");
	}

	refreshMetadata(metadataId?: string, metadataIds?: string[]): Promise<OperationQueuedResponse> {
		const body = metadataIds ? { metadataIds } : {};
		if (!metadataIds && metadataId) {
			return this._post("/admin/refresh-metadata", { body: { metadataId } });
		}

		return this._post("/admin/refresh-metadata", { body });
	}

	browseFilesystem(path?: string): Promise<AdminFilesystemBrowse> {
		return this._get("/admin/filesystem/browse", { query: path ? { path } : undefined });
	}

	getDatabaseBackups(): Promise<AdminDatabaseBackup[]> {
		return this._get("/admin/database/backups");
	}

	createDatabaseBackup(): Promise<AdminDatabaseBackup> {
		return this._post("/admin/database/backups", { body: undefined });
	}

	deleteDatabaseBackup(fileName: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/database/backups/${fileName}`);
	}

	getPlugins(): Promise<PluginRuntimeStatus[]> {
		return this._get("/admin/plugins");
	}

	reloadPlugins(): Promise<PluginRuntimeStatus[]> {
		return this._post("/admin/plugins/reload", { body: undefined });
	}

	getPlugin(pluginId: string): Promise<PluginRuntimeStatus> {
		return this._get(`/admin/plugins/${pluginId}`);
	}

	enablePlugin(pluginId: string): Promise<PluginRuntimeStatus> {
		return this._post(`/admin/plugins/${pluginId}/enable`, { body: undefined });
	}

	disablePlugin(pluginId: string): Promise<PluginRuntimeStatus> {
		return this._post(`/admin/plugins/${pluginId}/disable`, { body: undefined });
	}

	reloadPlugin(pluginId: string): Promise<PluginRuntimeStatus> {
		return this._post(`/admin/plugins/${pluginId}/reload`, { body: undefined });
	}

	// ─── Plugin catalog ───────────────────────────────────────────────────────
	getPluginRepositories(): Promise<PluginRepository[]> {
		return this._get("/admin/plugins/repositories");
	}

	createPluginRepository(body: { name: string; url: string; token?: string }): Promise<PluginRepository> {
		return this._post("/admin/plugins/repositories", { body });
	}

	updatePluginRepository(repositoryId: string, body: UpdatePluginRepositoryBody): Promise<PluginRepository> {
		return this._patch(`/admin/plugins/repositories/${repositoryId}`, { body });
	}

	deletePluginRepository(repositoryId: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/plugins/repositories/${repositoryId}`);
	}

	refreshPluginRepository(repositoryId: string): Promise<PluginRepository> {
		return this._post(`/admin/plugins/repositories/${repositoryId}/refresh`, { body: undefined });
	}

	getPluginCatalog(): Promise<PluginCatalogEntry[]> {
		return this._get("/admin/plugins/catalog");
	}

	installCatalogPlugin(body: InstallCatalogPluginBody): Promise<InstallCatalogPluginResponse> {
		return this._post("/admin/plugins/catalog/install", { body });
	}

	/**
	 * Installs (or upgrades) a plugin from a locally uploaded `.zip` / `.tar` /
	 * `.tar.gz` archive. Uses XMLHttpRequest rather than fetch because fetch
	 * exposes no upload-progress events; `onProgress` reports byte counts while
	 * the request body is being sent.
	 */
	installPluginArchive(
		file: File,
		onProgress?: (uploadedBytes: number, totalBytes: number) => void,
	): Promise<InstallCatalogPluginResponse> {
		return new Promise((resolve, reject) => {
			const request = new XMLHttpRequest();
			request.open("POST", buildUrl(this.config.baseUrl, "/admin/plugins/install-upload").toString());
			// Session auth is cookie-based (browsers carry no bearer token) — the
			// cookie must be attached even when the API lives on another origin.
			if (this.config.credentials === "include") request.withCredentials = true;

			if (this.config.accessToken) request.setRequestHeader("Authorization", `Bearer ${this.config.accessToken}`);

			request.timeout = 120_000;

			request.upload.addEventListener("progress", (event) => {
				if (event.lengthComputable) onProgress?.(event.loaded, event.total);
			});
			request.addEventListener("load", () => {
				const body = parseJsonBody(request.responseText);
				if (request.status >= 200 && request.status < 300) {
					if (isInstallResponse(body)) {
						resolve(body);

						return;
					}

					reject(new Error("Plugin install returned an unexpected response."));

					return;
				}

				reject(new Error(extractErrorMessage(body) ?? `Plugin install failed (HTTP ${request.status})`));
			});
			request.addEventListener("error", () => reject(new Error("Plugin install upload failed — check the server connection.")));
			request.addEventListener("timeout", () => reject(new Error("Plugin install upload timed out.")));
			request.addEventListener("abort", () => reject(new Error("Plugin install upload aborted.")));

			const form = new FormData();
			form.append("file", file);
			request.send(form);
		});
	}

	uninstallPlugin(pluginId: string): Promise<{ success: boolean }> {
		return this._post(`/admin/plugins/${pluginId}/uninstall`, { body: undefined });
	}

	getDownloadJobs(): Promise<AdminDownloadsResponse> {
		return this._get("/admin/downloads/jobs");
	}

	deleteDownloadJob(jobId: string): Promise<{ success: boolean }> {
		return this._delete(`/admin/downloads/jobs/${jobId}`);
	}
}

function parseJsonBody(text: string | undefined): unknown {
	if (!text) return undefined;

	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function isInstallResponse(value: unknown): value is InstallCatalogPluginResponse {
	return typeof value === "object" && value !== null && "pluginId" in value && "version" in value && "upgraded" in value;
}

function extractErrorMessage(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;

	if ("error" in body && typeof body.error === "string") return body.error;

	if ("message" in body && typeof body.message === "string") return body.message;

	return undefined;
}

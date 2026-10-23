import type {
	InstallCatalogPluginResponse,
	PluginRepository,
	PluginValidationResult,
	UpdatePluginRepositoryBody,
} from "@reelvault/sdk/common";
import { type PluginCatalogView, pluginCatalogService } from "@/plugins/catalog/plugin-catalog.service";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { recordAuditSafe } from "./admin-audit.service";

interface AuditContext {
	actorUserId?: string | undefined;
	headers?: Headers | undefined;
}

export const adminPluginCatalogService = {
	logger: createLogger("AdminPluginCatalog"),

	async listRepositories(): Promise<PluginRepository[]> {
		return await pluginCatalogService.listRepositories();
	},

	async createRepository(body: { name: string; url: string; token?: string }, context: AuditContext): Promise<PluginRepository> {
		const repository = await pluginCatalogService.createRepository(body);
		recordAuditSafe(
			{
				action: "create",
				resourceType: "plugin_repository",
				resourceId: repository.id,
				resourceName: repository.name,
				after: { name: repository.name, url: repository.url, hasToken: repository.hasToken },
				context,
			},
			adminPluginCatalogService.logger,
		);

		return repository;
	},

	async updateRepository(id: string, body: UpdatePluginRepositoryBody, context: AuditContext): Promise<PluginRepository> {
		// awaits: sequential — the before snapshot is read before the repository is updated
		const before = await pluginCatalogService.listRepositories().then((rows) => rows.find((row) => row.id === id));
		const repository = await pluginCatalogService.updateRepository(id, body);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_repository",
				resourceId: id,
				resourceName: repository.name,
				before: before ? { name: before.name, url: before.url, enabled: before.enabled, hasToken: before.hasToken } : null,
				after: { name: repository.name, url: repository.url, enabled: repository.enabled, hasToken: repository.hasToken },
				context,
			},
			adminPluginCatalogService.logger,
		);

		return repository;
	},

	async deleteRepository(id: string, context: AuditContext): Promise<{ success: boolean }> {
		const before = await pluginCatalogService.listRepositories().then((rows) => rows.find((row) => row.id === id));
		if (!before) throw new DomainError("not_found", `Plugin repository not found: ${id}`, { code: "plugin.repository_not_found" });

		await pluginCatalogService.deleteRepository(id);
		recordAuditSafe(
			{
				action: "delete",
				resourceType: "plugin_repository",
				resourceId: id,
				resourceName: before.name,
				before: { name: before.name, url: before.url },
				context,
			},
			adminPluginCatalogService.logger,
		);

		return { success: true };
	},

	async refreshRepository(id: string, context: AuditContext): Promise<PluginRepository> {
		const repository = await pluginCatalogService.refreshRepository(id);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_repository",
				resourceId: id,
				resourceName: repository.name,
				after: { action: "refresh", lastRefreshedAt: repository.lastRefreshedAt, lastErrorCode: repository.lastErrorCode },
				context,
			},
			adminPluginCatalogService.logger,
		);

		return repository;
	},

	async getCatalog(): Promise<PluginCatalogView> {
		return await pluginCatalogService.getCatalog();
	},

	async install(
		body: { repositoryId: string; pluginId: string; version?: string },
		context: AuditContext,
	): Promise<InstallCatalogPluginResponse> {
		const result = await pluginCatalogService.installFromCatalog(body);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_catalog_install",
				resourceId: result.pluginId,
				resourceName: result.pluginId,
				after: {
					version: result.version,
					upgraded: result.upgraded,
					repositoryId: body.repositoryId,
					requestedVersion: body.version ?? null,
				},
				context,
			},
			adminPluginCatalogService.logger,
		);

		return result;
	},

	async installUploadedArchive(file: File, context: AuditContext): Promise<InstallCatalogPluginResponse> {
		const result = await pluginCatalogService.installFromArchive(file, { source: `upload:${file.name}` });
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_upload_install",
				resourceId: result.pluginId,
				resourceName: result.pluginId,
				after: { version: result.version, upgraded: result.upgraded, fileName: file.name, size: file.size },
				context,
			},
			adminPluginCatalogService.logger,
		);

		return result;
	},

	/** Dry run of an uploaded archive. Read-only, so nothing is audited. */
	async validateUploadedArchive(file: File): Promise<PluginValidationResult> {
		return await pluginCatalogService.validateArchive(file);
	},

	async uninstall(pluginId: string, context: AuditContext): Promise<{ success: boolean }> {
		await pluginCatalogService.uninstallPlugin(pluginId);
		recordAuditSafe(
			{
				action: "delete",
				resourceType: "plugin",
				resourceId: pluginId,
				resourceName: pluginId,
				after: { action: "uninstall" },
				context,
			},
			adminPluginCatalogService.logger,
		);

		return { success: true };
	},
};

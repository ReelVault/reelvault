import type { InstallCatalogPluginResponse, PluginCatalogEntry, PluginRepository, UpdatePluginRepositoryBody } from "@sdk/common";
import { pluginCatalogService } from "@/plugins/catalog/plugin-catalog.service";
import { NotFoundError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { recordAuditSafe } from "./admin-audit.service";

interface AuditContext {
	actorUserId?: string | undefined;
	headers?: Headers | undefined;
}

class AdminPluginCatalogService {
	private readonly logger = createLogger("AdminPluginCatalog");

	async listRepositories(): Promise<PluginRepository[]> {
		return await pluginCatalogService.listRepositories();
	}

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
			this.logger,
		);

		return repository;
	}

	async updateRepository(id: string, body: UpdatePluginRepositoryBody, context: AuditContext): Promise<PluginRepository> {
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
			this.logger,
		);

		return repository;
	}

	async deleteRepository(id: string, context: AuditContext): Promise<{ success: boolean }> {
		const before = await pluginCatalogService.listRepositories().then((rows) => rows.find((row) => row.id === id));
		if (!before) throw new NotFoundError(`Plugin repository not found: ${id}`);

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
			this.logger,
		);

		return { success: true };
	}

	async refreshRepository(id: string, context: AuditContext): Promise<PluginRepository> {
		const repository = await pluginCatalogService.refreshRepository(id);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "plugin_repository",
				resourceId: id,
				resourceName: repository.name,
				after: { action: "refresh", lastRefreshedAt: repository.lastRefreshedAt, lastError: repository.lastError },
				context,
			},
			this.logger,
		);

		return repository;
	}

	async getCatalog(): Promise<PluginCatalogEntry[]> {
		return await pluginCatalogService.getCatalog();
	}

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
			this.logger,
		);

		return result;
	}

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
			this.logger,
		);

		return result;
	}

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
			this.logger,
		);

		return { success: true };
	}
}

export const adminPluginCatalogService = new AdminPluginCatalogService();

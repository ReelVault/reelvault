import type { MetadataItem } from "@reelvault/sdk/common";
import type { MetadataAvailability, ProviderMediaType } from "@reelvault/sdk/plugin";
import { pluginMetadataData } from "@/app/plugins/plugin-data.service";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { createLogger } from "@/utils/logger.utils";

class PluginMetadataService {
	readonly serviceName = "PluginMetadataService";
	readonly logger = createLogger("PluginMetadataService");

	async get(metadataId: string): Promise<MetadataItem | null> {
		const metadata = await pluginMetadataData.findById({
			primaryId: metadataId,
			fields: QueryFields.parse({ fields: "id,type,title,originalTitle,overview,tagline,releaseDate,status,providers" }),
		});
		if (!metadata) return null;

		return {
			id: metadata.id,
			type: metadata.type,
			title: metadata.title,
			originalTitle: metadata.originalTitle ?? undefined,
			overview: metadata.overview ?? undefined,
			tagline: metadata.tagline ?? undefined,
			releaseDate: metadata.releaseDate,
			status: metadata.status ?? undefined,
			externalIds: metadata.providers.map((provider) => ({
				providerId: provider.name,
				entityType: metadata.type,
				externalId: provider.externalId,
			})),
		};
	}

	async findByExternalId(providerId: string, externalId: string, type: ProviderMediaType): Promise<MetadataAvailability | null> {
		const [match] = await this.findManyByExternalIds(providerId, [externalId], type);

		return match ?? null;
	}

	async findManyByExternalIds(
		providerId: string,
		externalIds: readonly string[],
		type: ProviderMediaType,
	): Promise<MetadataAvailability[]> {
		const rows = await pluginMetadataData.findByProviderExternalIds({
			providerName: providerId,
			entityType: type,
			externalIds,
		});

		return rows.map((row) => ({
			externalId: row.externalId,
			metadataId: row.metadata.id,
			title: row.metadata.title,
			type: row.metadata.type,
			hasFiles: row.fileCount > 0,
			fileCount: row.fileCount,
		}));
	}
}

export const pluginMetadataService = new PluginMetadataService();

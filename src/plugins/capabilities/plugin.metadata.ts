import type { MetadataItem } from "@sdk/common";
import type { MetadataAvailability, ProviderMediaType } from "@sdk/plugin";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { QueryFields } from "@/database/utils/fields";
import { BaseService } from "@/utils/base-service";

class PluginMetadataService extends BaseService {
	constructor() {
		super("PluginMetadataService");
	}

	async get(metadataId: string): Promise<MetadataItem | null> {
		const metadata = await metadataRepository.findById({
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
		const rows = await metadataRepository.findByProviderExternalIds({
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

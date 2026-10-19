import { t } from "elysia";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";

/** Shared route-param schemas — one definition per path parameter so ID
 * validation rules (length caps etc.) never drift between route files. */

export const IdParams = t.Object({ id: t.String({ minLength: 1 }) });

export const MetadataIdParams = t.Object({ metadataId: t.String({ minLength: 1 }) });

export const CollectionIdParams = t.Object({ collectionId: t.String({ minLength: 1 }) });

export const CompanyIdParams = t.Object({ companyId: t.String({ minLength: 1 }) });

export const LibraryIdParams = t.Object({ libraryId: t.String({ minLength: 1 }) });

export const SessionIdParams = t.Object({ sessionId: t.String({ minLength: 1 }) });

export const MediaFileIdParams = t.Object({ mediaFileId: t.String({ minLength: 1 }) });

export const JobIdParams = t.Object({ jobId: t.String({ minLength: 1 }) });

export const PluginIdParams = t.Object({
	pluginId: t.String({ minLength: 1, maxLength: 128, pattern: PLUGIN_IDENTIFIER_PATTERN.source }),
});

export const UserIdParams = t.Object({ userId: t.String({ minLength: 1 }) });

export const UserProfileIdParams = t.Object({
	userId: t.String({ minLength: 1 }),
	profileId: t.String({ minLength: 1 }),
});

export const OperationIdParams = t.Object({ operationId: t.String({ minLength: 1 }) });

export const WorkerIdParams = t.Object({ workerId: t.String({ minLength: 1, maxLength: 128 }) });

export const RepositoryIdParams = t.Object({ repositoryId: t.String({ minLength: 1, maxLength: 64 }) });

export const GenreIdParams = t.Object({ genreId: t.String({ minLength: 1 }) });

export const KeywordIdParams = t.Object({ keywordId: t.String({ minLength: 1 }) });

export const SeasonIdParams = t.Object({ seasonId: t.String({ minLength: 1 }) });

export const EpisodeIdParams = t.Object({ episodeId: t.String({ minLength: 1 }) });

export const PersonIdParams = t.Object({ personId: t.String({ minLength: 1 }) });

export const ImageIdParams = t.Object({ imageId: t.String({ minLength: 1 }) });

export const MediaFileArtifactParams = t.Object({ mediaFileId: t.String({ minLength: 1 }), artifactId: t.String({ minLength: 1 }) });

export const ProviderIdParams = t.Object({ providerId: t.String({ minLength: 1, maxLength: 128 }) });

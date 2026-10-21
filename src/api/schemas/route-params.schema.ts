import { t } from "elysia";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";

/** Shared route-param schemas — one definition per path parameter so ID
 * validation rules (length caps etc.) never drift between route files. */

/** The identifier shape every path parameter accepts. */
const idField = t.String({ minLength: 1 });

export const IdParams = t.Object({ id: idField });

export const MetadataIdParams = t.Object({ metadataId: idField });

export const CollectionIdParams = t.Object({ collectionId: idField });

export const CompanyIdParams = t.Object({ companyId: idField });

export const LibraryIdParams = t.Object({ libraryId: idField });

export const SessionIdParams = t.Object({ sessionId: idField });

export const MediaFileIdParams = t.Object({ mediaFileId: idField });

export const JobIdParams = t.Object({ jobId: idField });

export const PluginIdParams = t.Object({
	pluginId: t.String({ minLength: 1, maxLength: 128, pattern: PLUGIN_IDENTIFIER_PATTERN.source }),
});

export const UserIdParams = t.Object({ userId: idField });

export const UserProfileIdParams = t.Object({
	userId: idField,
	profileId: idField,
});

export const OperationIdParams = t.Object({ operationId: idField });

export const WorkerIdParams = t.Object({ workerId: t.String({ minLength: 1, maxLength: 128 }) });

export const RepositoryIdParams = t.Object({ repositoryId: t.String({ minLength: 1, maxLength: 64 }) });

export const GenreIdParams = t.Object({ genreId: idField });

export const KeywordIdParams = t.Object({ keywordId: idField });

export const SeasonIdParams = t.Object({ seasonId: idField });

export const EpisodeIdParams = t.Object({ episodeId: idField });

export const PersonIdParams = t.Object({ personId: idField });

export const ImageIdParams = t.Object({ imageId: idField });

export const MediaFileArtifactParams = t.Object({ mediaFileId: idField, artifactId: idField });

export const ProviderIdParams = t.Object({ providerId: t.String({ minLength: 1, maxLength: 128 }) });

export const LibraryPathParams = t.Object({
	libraryId: idField,
	pathId: idField,
});

export const SessionSegmentParams = t.Object({
	sessionId: idField,
	segment: idField,
});

export const UserSessionParams = t.Object({
	userId: idField,
	sessionId: idField,
});

export const FileNameParams = t.Object({ fileName: idField });

export const LogFileQuery = t.Object({ fileId: t.Optional(t.String()) });

export const PluginArchiveUpload = t.Object({ file: t.File({ maxSize: "200m" }) });

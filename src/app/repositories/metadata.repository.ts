import { schema } from "@/integrations/drizzle-orm/database.schema";
import {
	deleteAndGetCleanup,
	deleteOrphansByIds,
	deleteWithMediaFiles,
	findMediaFileCleanupData,
	findOrphanIds,
} from "./metadata/cleanup.writer";
import {
	findById,
	findByIdForRead,
	findByProviderExternalIds,
	findByTitleAndType,
	findDistinctStatuses,
	findExistingIds,
	findFirst,
	findFirstProviderLink,
	findIdsPage,
	findMany,
	findManyByIdsWithRelations,
	findManyWithCursor,
	findNumberingModeById,
	findPage,
	findProviderDetails,
	findRecentlyAdded,
	findRecentlyAddedByType,
	findRootsById,
	findSimilarPage,
	findTypeById,
	getLockedFields,
	getMoreLikeThis,
} from "./metadata/queries.reader";
import {
	findMetadataProvider,
	metadataCast,
	metadataCollections,
	metadataCompanies,
	metadataCrew,
	metadataGenres,
	metadataImages,
	metadataKeywords,
	metadataProviders,
	metadataRatings,
	metadataTable,
} from "./metadata/shared.utils";
import {
	createAndRead,
	findOrCreateByIdentity,
	findOrCreateMetadata,
	flagMissingTranslation,
	linkProviders,
	setLockedFields,
	updateAndRead,
} from "./metadata/writes.writer";

/**
 * Facade over the metadata catalog. The behavior lives in `metadata/`, grouped
 * into queries, writes and cleanup; the class keeps the singleton API.
 */
class MetadataRepository {
	readonly table = schema.metadata;
	readonly primaryKeyColumn = metadataTable.primaryKeyColumn;
	readonly query = metadataTable.query;
	readonly selectMany = metadataTable.selectMany;
	readonly selectFirst = metadataTable.selectFirst;
	readonly selectFirstById = metadataTable.selectFirstById;
	readonly findOrCreate = metadataTable.findOrCreate;
	readonly insert = metadataTable.insert;
	readonly update = metadataTable.update;
	readonly delete = metadataTable.delete;
	readonly count = metadataTable.count;
	readonly isExists = metadataTable.isExists;
	readonly insertCast = metadataCast.insert;
	readonly deleteCast = metadataCast.delete;
	readonly insertCollections = metadataCollections.insert;
	readonly deleteCollections = metadataCollections.delete;
	readonly insertCompanies = metadataCompanies.insert;
	readonly deleteCompanies = metadataCompanies.delete;
	readonly insertCrew = metadataCrew.insert;
	readonly deleteCrew = metadataCrew.delete;
	readonly insertGenres = metadataGenres.insert;
	readonly deleteGenres = metadataGenres.delete;
	readonly insertImages = metadataImages.insert;
	readonly deleteImages = metadataImages.delete;
	readonly insertKeywords = metadataKeywords.insert;
	readonly deleteKeywords = metadataKeywords.delete;
	readonly insertProviders = metadataProviders.insert;
	readonly deleteProviders = metadataProviders.delete;
	readonly findProvider = findMetadataProvider;
	readonly insertRatings = metadataRatings.insert;
	readonly deleteRatings = metadataRatings.delete;

	readonly findDistinctStatuses = findDistinctStatuses;
	readonly findIdsPage = findIdsPage;
	readonly findMany = findMany;
	readonly findManyWithCursor = findManyWithCursor;
	readonly findPage = findPage;
	readonly findByIdForRead = findByIdForRead;
	readonly findProviderDetails = findProviderDetails;
	readonly findTypeById = findTypeById;
	readonly findNumberingModeById = findNumberingModeById;
	readonly findRootsById = findRootsById;
	readonly findExistingIds = findExistingIds;
	readonly findManyByIdsWithRelations = findManyByIdsWithRelations;
	readonly findByTitleAndType = findByTitleAndType;
	readonly findFirstProviderLink = findFirstProviderLink;
	readonly findByProviderExternalIds = findByProviderExternalIds;
	readonly flagMissingTranslation = flagMissingTranslation;
	readonly getLockedFields = getLockedFields;
	readonly setLockedFields = setLockedFields;
	readonly createAndRead = createAndRead;
	readonly updateAndRead = updateAndRead;
	readonly deleteAndGetCleanup = deleteAndGetCleanup;
	readonly findSimilarPage = findSimilarPage;
	readonly findFirst = findFirst;
	readonly findById = findById;
	readonly findOrCreateByIdentity = findOrCreateByIdentity;
	readonly findRecentlyAddedByType = findRecentlyAddedByType;
	readonly findRecentlyAdded = findRecentlyAdded;
	readonly findOrphanIds = findOrphanIds;
	readonly deleteOrphansByIds = deleteOrphansByIds;
	readonly findMediaFileCleanupData = findMediaFileCleanupData;
	readonly deleteWithMediaFiles = deleteWithMediaFiles;
	readonly getMoreLikeThis = getMoreLikeThis;
	readonly findOrCreateMetadata = findOrCreateMetadata;
	readonly linkProviders = linkProviders;
}

export type { MetadataRootRow } from "./metadata/shared.utils";

export const metadataRepository = new MetadataRepository();

import { defineRepository } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
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
	findPage,
	findProviderDetails,
	findRecentlyAddedByTypes,
	findRootsById,
	findSimilarPage,
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
 * into queries, writes and cleanup; this object keeps the singleton API and the
 * join-table writes; the table-access delegations come from `defineRepository`.
 */
const overrides = {
	insertCast: metadataCast.insert,
	deleteCast: metadataCast.delete,
	insertCollections: metadataCollections.insert,
	deleteCollections: metadataCollections.delete,
	insertCompanies: metadataCompanies.insert,
	deleteCompanies: metadataCompanies.delete,
	insertCrew: metadataCrew.insert,
	deleteCrew: metadataCrew.delete,
	insertGenres: metadataGenres.insert,
	deleteGenres: metadataGenres.delete,
	insertImages: metadataImages.insert,
	deleteImages: metadataImages.delete,
	insertKeywords: metadataKeywords.insert,
	deleteKeywords: metadataKeywords.delete,
	insertProviders: metadataProviders.insert,
	deleteProviders: metadataProviders.delete,
	findProvider: findMetadataProvider,
	insertRatings: metadataRatings.insert,
	deleteRatings: metadataRatings.delete,

	findDistinctStatuses,
	findIdsPage,
	findMany,
	findManyWithCursor,
	findPage,
	findByIdForRead,
	findProviderDetails,
	findRootsById,
	findExistingIds,
	findManyByIdsWithRelations,
	findByTitleAndType,
	findFirstProviderLink,
	findByProviderExternalIds,
	flagMissingTranslation,
	getLockedFields,
	setLockedFields,
	createAndRead,
	updateAndRead,
	deleteAndGetCleanup,
	findSimilarPage,
	findFirst,
	findById,
	findOrCreateByIdentity,
	findRecentlyAddedByTypes,
	findOrphanIds,
	deleteOrphansByIds,
	findMediaFileCleanupData,
	deleteWithMediaFiles,
	getMoreLikeThis,
	findOrCreateMetadata,
	linkProviders,
};

export const metadataRepository = defineRepository(metadataTable, overrides);

export type { MetadataRootRow } from "./metadata/shared.utils";

import { linkProvider, rematch } from "./providers/provider-link.service";
import { getImageOptions, refreshImages, refreshImagesMany, selectImage, uploadImage } from "./records/images.service";
import { getAll, getById, getDetailsView, getRootsById, getSimilar, getStatuses, searchGlobal } from "./records/reads.reader";
import { deleteMany, deleteOne, deleteOrphans } from "./records/remove.service";
import { create, mergeMetadata, update } from "./records/writes.writer";

/**
 * The metadata use cases, grouped by responsibility under this folder: reads,
 * writes and removal (`records/`), artwork (`records/images`), and provider
 * links (`providers/`).
 */
export const metadataService = {
	/** Poster and backdrop options from the linked providers, best provider score first. */
	getImageOptions,
	selectImage,
	uploadImage,
	getStatuses,
	searchGlobal,
	getAll,
	getById,
	/** The flat metadata row without relation queries, for composite views that only carry the root row. */
	getRootsById,
	getDetailsView,
	create,
	update,
	rematch,
	/** Links one more provider and re-aggregates by priority; unlike `rematch`, the primary provider stays. */
	linkProvider,
	deleteMany,
	delete: deleteOne,
	deleteOrphans,
	mergeMetadata,
	getSimilar,
	refreshImagesMany,
	refreshImages,
};

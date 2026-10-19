import type { MediaIdentity } from "@reelvault/sdk/common";
import type { SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar.reader";
import { providerService } from "@/plugins/capabilities/provider.service";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { createLogger } from "@/utils/logger.utils";
import { createInFlightCache } from "@/utils/memory.cache";
import type { TaskSchedulingOptions } from "@/utils/task-context.types";
import { enqueueImageProcessing, type ImageProcessingData } from "@/workers/definitions/images/image-processing.worker";
import { resolveLibraryLanguage } from "../providers/library-metadata-language.resolver";
import type { CreatedProviderMetadata } from "../providers/metadata-create.utils";
import { processAggregatedMatch, processCreatedBase } from "./base.service";
import { processMovieMetadata, processTVShowMetadata } from "./entries.service";
import { createSidecarMetadata, findExistingLocalMetadata, findMetadataByIdentifiers, resolveLocalTVShow } from "./lookup.service";
import type { EnqueueImages, MetadataProcessResult, MetadataProcessState } from "./shared.types";

const enqueueImagesInBackground: EnqueueImages = (data: ImageProcessingData, options: TaskSchedulingOptions = {}): Promise<unknown> =>
	enqueueImageProcessing(data, options);

interface SidecarResolution {
	state: MetadataProcessState;
	type: "movie" | "tv_show";
	parsed: MediaIdentity;
	sidecar: SidecarMetadataHint | undefined;
	scheduling: TaskSchedulingOptions | undefined;
	language: string | undefined;
}

/**
 * Step 0 of the resolution order: a local NFO carrying imdb/tmdb ids pins the
 * title without any provider round-trip — works fully offline. `undefined` when
 * the sidecar names no known title, so the lookup continues with the database.
 */
async function resolveFromSidecar({
	state,
	type,
	parsed,
	sidecar,
	scheduling,
	language,
}: SidecarResolution): Promise<MetadataProcessResult | undefined> {
	if (!sidecar) return undefined;

	const sidecarMatch = await findMetadataByIdentifiers(type, sidecar);
	if (!sidecarMatch) return undefined;

	if (type === "movie") {
		return await processMovieMetadata(state, sidecarMatch.metadataId, sidecarMatch.stableKey);
	}

	// An undefined TV match falls through to the local-database lookup.
	const tvShow = await processTVShowMetadata(state, sidecarMatch.metadataId, parsed, sidecarMatch.metadata, {
		metadataStableKey: sidecarMatch.stableKey,
		scheduling,
		providers: sidecarMatch.providers,
		sidecarHint: sidecar,
		language,
	});

	return tvShow ?? undefined;
}

export class MetadataProcess {
	readonly serviceName = "MetadataProcess";
	readonly logger = createLogger("MetadataProcess");

	private readonly state: MetadataProcessState;

	constructor(enqueueImages: EnqueueImages = enqueueImagesInBackground) {
		this.state = {
			logger: this.logger,
			enqueueImages,
			baseMetadataProcesses: createInFlightCache<CreatedProviderMetadata>(),
			imageEnqueueProcesses: createInFlightCache<void>(),
		};
	}

	async checkMetadata({
		type,
		parsed,
		sidecar,
		signal,
		scheduling,
		libraryId,
	}: {
		type: "movie" | "tv_show";
		parsed: MediaIdentity;
		sidecar?: SidecarMetadataHint | undefined;
		signal?: AbortSignal | undefined;
		scheduling?: TaskSchedulingOptions | undefined;
		libraryId?: string | undefined;
	}): Promise<MetadataProcessResult | undefined> {
		const state = this.state;
		try {
			throwIfAborted(signal);

			// The per-library language override applies to every resolution path —
			// series details, seasons and episodes alike — so it is resolved once here.
			const language = await resolveLibraryLanguage(libraryId);

			// 0. Sidecar-first: a local NFO carrying imdb/tmdb ids pins the title
			// without any provider round-trip — works fully offline.
			const sidecarResult = await resolveFromSidecar({ state, type, parsed, sidecar, scheduling, language });
			if (sidecarResult) return sidecarResult;

			// 0b. A TMDB id named in the file or folder name (or the NFO) names the exact title: fetch that entry
			// instead of searching by title. An id the provider does not know falls through to the search below.
			let namedTitle: Awaited<ReturnType<typeof providerService.fetchAggregatedDetailsByProvider>> = null;
			if (sidecar?.identifiers.tmdb) {
				namedTitle = await providerService.fetchAggregatedDetailsByProvider("tmdb", type, sidecar.identifiers.tmdb, { language });
			}
			if (namedTitle) return await processAggregatedMatch(state, type, parsed, namedTitle, { scheduling, language });

			// 1. Check the local database first — the metadata may already exist.
			// The NFO title/year (when present) beat the filename parse.
			const enrichedParsed: MediaIdentity = { ...parsed, title: sidecar?.title ?? parsed.title, year: sidecar?.year ?? parsed.year };
			const existingLocal = await findExistingLocalMetadata(state, type, enrichedParsed);
			if (existingLocal) {
				if (type === "movie") {
					return await processMovieMetadata(state, existingLocal.id, existingLocal.stableKey);
				}

				// An undefined TV match falls through to the provider search.
				const tvShow = await resolveLocalTVShow(state, { existing: existingLocal, parsed, scheduling, sidecarHint: sidecar, language });
				if (tvShow) return tvShow;
			}

			// 2. If not found locally, search metadata providers (e.g. TMDB) and merge the results
			const aggregated = await providerService.fetchAggregatedDetails(type, enrichedParsed, { libraryId, language });
			throwIfAborted(signal);

			if (!aggregated) {
				// 3. Sidecar offline import: no local row, no provider hit — build the
				// metadata row from the NFO itself so an offline server still imports.
				let fromSidecar: Awaited<ReturnType<typeof createSidecarMetadata>> | undefined;
				if (sidecar?.title) {
					fromSidecar = await createSidecarMetadata(state, type, sidecar);
				}
				if (!fromSidecar) {
					this.logger.debug("No metadata match found", { title: enrichedParsed.title, year: enrichedParsed.year, type });

					return undefined;
				}

				return await processCreatedBase(state, type, parsed, fromSidecar.base, {
					scheduling,
					providers: fromSidecar.providers,
					sidecarHint: sidecar,
					language,
				});
			}

			return await processAggregatedMatch(state, type, parsed, aggregated, { scheduling, language });
		} catch (error) {
			this.logger.error("Check metadata failed", error, { type, parsed });
			throw error;
		}
	}
}

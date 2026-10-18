import type { Logger } from "@reelvault/sdk/common";
import type { CreatedProviderMetadata } from "@/app/catalog/metadata/providers/metadata-create.utils";
import type { SidecarMetadataHint } from "@/modules/metadata-sidecars/files/local-sidecar.reader";
import type { InFlightMap } from "@/utils/concurrency.utils";
import type { TaskSchedulingOptions } from "@/utils/task-context.types";
import type { ImageProcessingData } from "@/workers/definitions/images/image-processing.worker";

export type EnqueueImages = (data: ImageProcessingData, options?: TaskSchedulingOptions) => Promise<unknown>;

export interface MetadataProcessResult {
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

export interface TvProcessOptions {
	metadataStableKey?: string | null | undefined;
	scheduling?: TaskSchedulingOptions | undefined;
	providers?: Array<{ providerId: string; externalId: string }> | undefined;
	sidecarHint?: SidecarMetadataHint | undefined;
	language?: string | undefined;
}

/** What the metadata functions share: the logger, the artwork queue and the in-flight de-duplication maps. */
export interface MetadataProcessState {
	readonly logger: Logger;
	readonly enqueueImages: EnqueueImages;
	readonly baseMetadataProcesses: InFlightMap<CreatedProviderMetadata>;
	readonly imageEnqueueProcesses: InFlightMap<void>;
}

import { metadataSidecarsService } from "./metadata-sidecars.service";
import { sidecarSnapshots } from "./sidecar.ports";
import type { SidecarMetadataWriter, SidecarSnapshotResolver } from "./sidecar.types";

/** Resolves snapshots through the port at call time, so the writer exists before the application wires its resolver. */
const snapshots: SidecarSnapshotResolver = {
	metadata: async (metadataId) => await sidecarSnapshots().metadata(metadataId),
	season: async (seasonId) => await sidecarSnapshots().season(seasonId),
	episode: async (episodeId) => await sidecarSnapshots().episode(episodeId),
};

export const sidecarMetadataWriter: SidecarMetadataWriter = metadataSidecarsService.createSidecarWriter(snapshots);

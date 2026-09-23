import { metadataSidecarsService } from "./metadata-sidecars.service";
import type { SidecarMetadataWriter } from "./sidecar.types";
import { DatabaseSidecarSnapshotResolver } from "./sidecar-snapshot-resolver";

export const sidecarMetadataWriter: SidecarMetadataWriter = metadataSidecarsService.createSidecarWriter(
	new DatabaseSidecarSnapshotResolver(),
);

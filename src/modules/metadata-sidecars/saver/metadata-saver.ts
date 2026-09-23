import { InternalError } from "@/utils/errors";
import type { SidecarFormatRegistry } from "../formats/sidecar-format.registry";
import type {
	SidecarFlavor,
	SidecarMetadataWriter,
	SidecarSnapshotDocument,
	SidecarSnapshotResolver,
	SidecarWriteResult,
} from "../sidecar.types";
import { getSidecarPathPolicy } from "./sidecar-path.policy";

export class RegistrySidecarMetadataWriter implements SidecarMetadataWriter {
	private readonly registry: SidecarFormatRegistry;
	private readonly snapshots: SidecarSnapshotResolver;

	constructor(registry: SidecarFormatRegistry, snapshots: SidecarSnapshotResolver) {
		this.registry = registry;
		this.snapshots = snapshots;
	}

	async saveMovie({
		metadataId,
		movieDirectory,
		flavor = "reelvault",
	}: {
		metadataId: string;
		movieDirectory: string;
		flavor?: SidecarFlavor | undefined;
	}): Promise<SidecarWriteResult> {
		return await this.write(flavor, getSidecarPathPolicy(flavor).movie(movieDirectory), await this.snapshots.metadata(metadataId));
	}

	async saveSeries({
		metadataId,
		seriesDirectory,
		flavor = "reelvault",
	}: {
		metadataId: string;
		seriesDirectory: string;
		flavor?: SidecarFlavor | undefined;
	}): Promise<SidecarWriteResult> {
		return await this.write(flavor, getSidecarPathPolicy(flavor).series(seriesDirectory), await this.snapshots.metadata(metadataId));
	}

	async saveSeason({
		seasonId,
		seasonDirectory,
		seasonNumber,
		flavor = "reelvault",
		snapshot,
	}: {
		seasonId: string;
		seasonDirectory: string;
		seasonNumber: number;
		flavor?: SidecarFlavor | undefined;
		snapshot?: SidecarSnapshotDocument | undefined;
	}): Promise<SidecarWriteResult> {
		return await this.write(
			flavor,
			getSidecarPathPolicy(flavor).season(seasonDirectory, seasonNumber),
			snapshot ?? (await this.snapshots.season(seasonId)),
		);
	}

	async saveEpisode({
		episodeId,
		episodeDirectory,
		videoBaseName,
		flavor = "reelvault",
		snapshot,
	}: {
		episodeId: string;
		episodeDirectory: string;
		videoBaseName: string;
		flavor?: SidecarFlavor | undefined;
		snapshot?: SidecarSnapshotDocument | undefined;
	}): Promise<SidecarWriteResult> {
		return await this.write(
			flavor,
			getSidecarPathPolicy(flavor).episode(episodeDirectory, videoBaseName),
			snapshot ?? (await this.snapshots.episode(episodeId)),
		);
	}

	private async write(flavor: SidecarFlavor, documentPath: string, document: SidecarSnapshotDocument): Promise<SidecarWriteResult> {
		const adapter = this.registry.find(flavor);
		if (!adapter?.write)
			throw new InternalError(`Sidecar format adapter is not registered for writing: ${flavor}`, {
				code: "sidecar.adapter_not_registered",
			});

		return await adapter.write({ documentPath, document });
	}
}

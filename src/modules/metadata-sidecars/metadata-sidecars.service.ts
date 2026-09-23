import { BaseService } from "@/utils/base-service";
import { findIgnoredLocalAssets } from "./files/ignored-assets.diagnostics";
import { JellyfinFormatAdapter } from "./formats/jellyfin/jellyfin-format.adapter";
import { KodiFormatAdapter } from "./formats/kodi/kodi-format.adapter";
import { ReelVaultFormatAdapter } from "./formats/reelvault/reelvault-format.adapter";
import { InMemorySidecarFormatRegistry, type SidecarFormatRegistry } from "./formats/sidecar-format.registry";
import { RegistrySidecarMetadataWriter } from "./saver/metadata-saver";
import type { CanonicalSidecarDocument, SidecarMetadataWriter, SidecarSnapshotResolver } from "./sidecar.types";

class MetadataSidecarsService extends BaseService {
	private readonly registry: SidecarFormatRegistry;

	constructor(registry?: SidecarFormatRegistry) {
		super("MetadataSidecarsService");
		if (registry) {
			this.registry = registry;
		} else {
			this.registry = new InMemorySidecarFormatRegistry();
			this.registry.register(new ReelVaultFormatAdapter());
			this.registry.register(new JellyfinFormatAdapter());
			this.registry.register(new KodiFormatAdapter());
		}
	}

	findIgnoredAssets(root: string) {
		return findIgnoredLocalAssets(root);
	}

	createSidecarWriter(snapshots: SidecarSnapshotResolver): SidecarMetadataWriter {
		return new RegistrySidecarMetadataWriter(this.registry, snapshots);
	}

	async readDocument(documentPath: string): Promise<CanonicalSidecarDocument | null> {
		const reader = await this.registry.findReader({ documentPath });
		if (!reader) return null;

		return (await reader.read?.({ documentPath })) ?? null;
	}
}

export const metadataSidecarsService = new MetadataSidecarsService();

import type { PlaybackArtifact, PlaybackArtifactWrite } from "@reelvault/sdk/common";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { serverConfig } from "@/config/server/server.config";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";

/**
 * Plugin-facing facade over the shared media-artifacts store. Core generators
 * (trickplay) write to the same store with their own budget; only this boundary
 * applies the per-plugin quota (`plugins.artifacts.maxTotalBytesPerPlugin`).
 */
class PluginArtifactsService {
	readonly serviceName = "PluginArtifactsService";
	readonly logger = createLogger("PluginArtifactsService");

	list(mediaFileId: string): Promise<PlaybackArtifact[]> {
		return mediaArtifactsService.list(mediaFileId);
	}

	write(pluginId: string, artifact: PlaybackArtifactWrite): Promise<PlaybackArtifact> {
		return mediaArtifactsService.write(pluginId, artifact, {
			assertWithinQuota: (_ownerId, bytesAfterWrite) => this.assertWithinPluginQuota(pluginId, bytesAfterWrite),
		});
	}

	deleteByMediaFileIdAndKind(mediaFileId: string, kind: string, pluginId?: string): Promise<number> {
		return mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, kind, pluginId);
	}

	/** Used on uninstall: drops every artifact row and file the plugin produced. */
	removeForPlugin(pluginId: string): Promise<number> {
		return mediaArtifactsService.removeForOwner(pluginId);
	}

	private assertWithinPluginQuota(pluginId: string, totalBytes: number): void {
		const maxTotalBytes = serverConfig.plugins.artifacts.maxTotalBytesPerPlugin;
		if (totalBytes > maxTotalBytes) {
			throw new DomainError(
				"validation",
				`Plugin '${pluginId}' artifact storage must not exceed ${(maxTotalBytes / 1024 / 1024).toFixed(0)} MB (${maxTotalBytes} bytes).`,
				{ code: "plugin.artifact.quota_exceeded" },
			);
		}
	}
}

export const pluginArtifactsService = new PluginArtifactsService();

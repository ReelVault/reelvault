import type { PlaybackArtifact, PlaybackArtifactWrite } from "@reelvault/sdk/common";
import { file } from "bun";
import { databaseFactory } from "@/database/database";
import { mediaArtifactsRepository } from "@/database/repositories/media-artifacts.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import type { InferTable } from "@/database/types";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import { contentByteSize, writeFileWithRollback } from "@/plugins/shared/plugin.file-record.utils";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError, NotFoundError, ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

type MediaArtifactRow = InferTable<"mediaArtifacts">;

const VALID_ARTIFACT_KINDS = new Set(["trickplay", "chapters", "preview", "waveform"]);

class PluginArtifactsService extends BaseService {
	constructor() {
		super("PluginArtifactsService");
	}

	async list(mediaFileId: string): Promise<PlaybackArtifact[]> {
		const artifacts = await mediaArtifactsRepository.findByMediaFileId(mediaFileId);

		return artifacts.map((artifact) => this.toPublicArtifact(artifact));
	}

	async write(pluginId: string, artifact: PlaybackArtifactWrite): Promise<PlaybackArtifact> {
		if (typeof artifact !== "object") {
			throw new ValidationError(`Plugin '${pluginId}' artifact write failed: artifact must be an object.`, {
				code: "plugin.artifact.invalid_request",
			});
		}

		if (!artifact.mediaFileId || typeof artifact.mediaFileId !== "string") {
			throw new ValidationError(`Plugin '${pluginId}' artifact write failed: missing or invalid 'mediaFileId'.`, {
				code: "plugin.artifact.invalid_request",
			});
		}

		if (!VALID_ARTIFACT_KINDS.has(artifact.kind)) {
			throw new ValidationError(
				`Plugin '${pluginId}' artifact write failed: invalid kind '${artifact.kind}'. Supported kinds: 'trickplay', 'chapters', 'preview', 'waveform'.`,
				{ code: "plugin.artifact.invalid_request" },
			);
		}

		this.assertAllowedContentType(artifact.contentType, pluginId);

		this.assertArtifactSize(artifact.content, pluginId);
		await this.assertWithinPluginQuota(pluginId, contentByteSize(artifact.content));

		const candidate = await pluginHookBus.runBeforeArtifactCreate({
			mediaFileId: artifact.mediaFileId,
			kind: artifact.kind,
			contentType: artifact.contentType,
			size: contentByteSize(artifact.content),
		});
		const normalizedArtifact = { ...artifact, kind: candidate.kind, contentType: candidate.contentType };

		const mediaFileExists = await mediaRepository.isExists({ primaryId: normalizedArtifact.mediaFileId });
		if (!mediaFileExists)
			throw new NotFoundError(`Plugin '${pluginId}' artifact write failed: media file '${normalizedArtifact.mediaFileId}' was not found.`, {
				code: "plugin.artifact.not_found",
			});

		const id = crypto.randomUUID();
		const storageKey = `${normalizedArtifact.mediaFileId}/${id}`;
		const stableKey = createLocalStableKey({ namespace: "media-artifact", value: `${pluginId}:${storageKey}` });
		const mediaArtifactsDir = PathUtils.join(serverConfig.paths.artifacts, normalizedArtifact.mediaFileId);
		await DirUtils.create(mediaArtifactsDir);

		const storedRows = await writeFileWithRollback(this.storagePath(storageKey), normalizedArtifact.content, () =>
			databaseFactory
				.getClient()
				.insert(mediaArtifactsRepository.table)
				.values({
					id,
					mediaFileId: normalizedArtifact.mediaFileId,
					pluginId,
					stableKey,
					kind: normalizedArtifact.kind,
					contentType: normalizedArtifact.contentType,
					storageKey,
				})
				.returning(),
		);

		const storedArtifact = storedRows[0];
		if (!storedArtifact)
			throw new InternalError(`Plugin '${pluginId}' artifact write failed: artifact '${id}' could not be saved.`, {
				code: "plugin.artifact.save_failed",
			});

		const publicArtifact = this.toPublicArtifact(storedArtifact);
		pluginEventBus.publish("artifact.created", {
			mediaFileId: normalizedArtifact.mediaFileId,
			artifactId: publicArtifact.id,
			artifactType: publicArtifact.kind,
		});

		return publicArtifact;
	}

	async deleteByMediaFileIdAndKind(mediaFileId: string, kind: string, pluginId?: string): Promise<number> {
		const artifacts = await mediaArtifactsRepository.findByMediaFileId(mediaFileId);
		// When scoped, a plugin may only delete its own artifacts of that kind.
		const matching = artifacts.filter((a) => a.kind === kind && (pluginId === undefined || a.pluginId === pluginId));
		if (matching.length === 0) return 0;

		await PromiseUtils.mapConcurrent(matching, serverConfig.plugins.artifacts.cleanupConcurrency, (artifact) =>
			mediaArtifactsRepository.delete({ primaryId: artifact.id }),
		);
		await this.removeStorageFiles(matching.map((a) => a.storageKey));

		return matching.length;
	}

	async findFile(mediaFileId: string, artifactId: string): Promise<{ artifact: PlaybackArtifact; file: Blob } | null> {
		const artifact = await mediaArtifactsRepository.findById(artifactId);
		if (!artifact || artifact.mediaFileId !== mediaFileId) return null;

		const artifactFile = file(this.storagePath(artifact.storageKey));
		if (!(await artifactFile.exists())) return null;

		return { artifact: this.toPublicArtifact(artifact), file: artifactFile };
	}

	/** Removes every artifact row and file a plugin ever produced — used on uninstall so no orphans remain. */
	async removeForPlugin(pluginId: string): Promise<number> {
		const artifacts = await mediaArtifactsRepository.findByPluginId(pluginId);
		if (artifacts.length === 0) return 0;

		await PromiseUtils.mapConcurrent(artifacts, serverConfig.plugins.artifacts.cleanupConcurrency, (artifact) =>
			mediaArtifactsRepository.delete({ primaryId: artifact.id }),
		);
		await this.removeStorageFiles(artifacts.map((artifact) => artifact.storageKey));

		return artifacts.length;
	}

	async removeStorageFiles(storageKeys: readonly string[]): Promise<void> {
		await PromiseUtils.mapConcurrent(storageKeys, serverConfig.plugins.artifacts.cleanupConcurrency, (storageKey) =>
			FileUtils.delete(this.storagePath(storageKey)),
		);
	}

	private toPublicArtifact(artifact: MediaArtifactRow): PlaybackArtifact {
		return {
			id: artifact.id,
			mediaFileId: artifact.mediaFileId,
			pluginId: artifact.pluginId,
			kind: artifact.kind,
			url: `/v1/media-files/${artifact.mediaFileId}/artifacts/${artifact.id}`,
			contentType: artifact.contentType,
			createdAt: artifact.createdAt.toISOString(),
		};
	}

	private storagePath(storageKey: string): string {
		return PathUtils.join(serverConfig.paths.artifacts, storageKey);
	}

	private assertAllowedContentType(contentType: string, pluginId: string): void {
		const allowed = serverConfig.plugins.artifacts.allowedContentTypes;
		if (!allowed.includes(contentType)) {
			throw new ValidationError(
				`Plugin '${pluginId}' artifact write failed: content type '${contentType}' is not allowed. Supported: ${allowed.join(", ")}.`,
				{ code: "plugin.artifact.invalid_content_type" },
			);
		}
	}

	private assertArtifactSize(content: PlaybackArtifactWrite["content"], pluginId?: string): void {
		const size = contentByteSize(content);
		if (size > serverConfig.plugins.artifacts.maxSizeBytes) {
			const pluginPrefix = pluginId ? `Plugin '${pluginId}' artifact` : "Artifact";
			throw new ValidationError(
				`${pluginPrefix} size (${(size / 1024 / 1024).toFixed(2)} MB) exceeds the maximum allowed limit of ${(serverConfig.plugins.artifacts.maxSizeBytes / 1024 / 1024).toFixed(2)} MB (${serverConfig.plugins.artifacts.maxSizeBytes} bytes).`,
				{ code: "plugin.artifact.too_large" },
			);
		}
	}

	/**
	 * Caps the sum of one plugin's stored artifacts. Existing sizes come from
	 * stat'ing the stored files (the artifacts table has no size column), so the
	 * check runs per write — artifact writes are rare enough for that.
	 */
	private async assertWithinPluginQuota(pluginId: string, incomingBytes: number): Promise<void> {
		const existing = await mediaArtifactsRepository.findByPluginId(pluginId);
		let totalBytes = incomingBytes;
		for (const artifact of existing) {
			const stats = await FileUtils.getStats(this.storagePath(artifact.storageKey));
			totalBytes += stats?.size ?? 0;
		}

		if (totalBytes > serverConfig.plugins.artifacts.maxTotalBytesPerPlugin) {
			throw new ValidationError(
				`Plugin '${pluginId}' artifact storage must not exceed ${(serverConfig.plugins.artifacts.maxTotalBytesPerPlugin / 1024 / 1024).toFixed(0)} MB (${serverConfig.plugins.artifacts.maxTotalBytesPerPlugin} bytes).`,
				{ code: "plugin.artifact.quota_exceeded" },
			);
		}
	}
}

export const pluginArtifactsService = new PluginArtifactsService();

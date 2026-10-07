import type { PlaybackArtifact, PlaybackArtifactWrite } from "@reelvault/sdk/common";
import { file } from "bun";
import { databaseFactory } from "@/database/database";
import { mediaArtifactsRepository } from "@/database/repositories/media-artifacts.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { forEachChunked } from "@/database/table-access";
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
import { MemoryCache } from "@/utils/memory-cache";
import { KeyedMutex } from "@/utils/mutex";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

type MediaArtifactRow = InferTable<"mediaArtifacts">;

const VALID_ARTIFACT_KINDS = new Set(["trickplay", "chapters", "preview", "waveform"]);

/**
 * Optional write gate, evaluated under the per-owner write lock with the
 * owner's resulting byte total. Policy stays with the caller: the plugin
 * adapter enforces the per-plugin quota, core generators enforce the core
 * artifacts budget — this service only stores and serves.
 */
export interface ArtifactWriteOptions {
	assertWithinQuota?: ((ownerId: string, bytesAfterWrite: number, incomingBytes: number) => void | Promise<void>) | undefined;
}

/**
 * Shared playback-artifact store (table `media_artifacts`, `data/artifacts/`).
 * Both built-in generators and plugins write here; "plugin artifact" naming
 * only survives at the plugin capability boundary.
 */
class MediaArtifactsService extends BaseService {
	/**
	 * Per-owner stored bytes. The artifacts table has no size column, so the
	 * total comes from stat'ing every stored file; trickplay writes dozens of
	 * sprites per title, and recomputing per write made that O(writes x files).
	 * Invalidated on every delete path (the only way stored bytes shrink).
	 */
	private readonly ownerByteTotals = new MemoryCache<number>({ ttlMs: -1, maxSize: 64, name: "artifact-owner-totals" });
	/** Per-owner write serialisation for the quota check-then-write window. */
	private readonly writeLocks = new KeyedMutex();

	constructor() {
		super("MediaArtifactsService");
	}

	async list(mediaFileId: string): Promise<PlaybackArtifact[]> {
		const artifacts = await mediaArtifactsRepository.findByMediaFileId(mediaFileId);

		return artifacts.map((artifact) => this.toPublicArtifact(artifact));
	}

	async write(ownerId: string, artifact: PlaybackArtifactWrite, options?: ArtifactWriteOptions): Promise<PlaybackArtifact> {
		// The quota/budget check reads-then-writes the cached byte total; serialise
		// writes per owner so two concurrent artifacts cannot both pass against the
		// same base and overshoot the cap (or poison the cached total).
		return await this.writeLocks.runExclusive(ownerId, async () => await this.writeUnlocked(ownerId, artifact, options));
	}

	private async writeUnlocked(ownerId: string, artifact: PlaybackArtifactWrite, options?: ArtifactWriteOptions): Promise<PlaybackArtifact> {
		if (typeof artifact !== "object") {
			throw new ValidationError(`Artifact owner '${ownerId}' write failed: artifact must be an object.`, {
				code: "artifact.invalid_request",
			});
		}

		if (!artifact.mediaFileId || typeof artifact.mediaFileId !== "string") {
			throw new ValidationError(`Artifact owner '${ownerId}' write failed: missing or invalid 'mediaFileId'.`, {
				code: "artifact.invalid_request",
			});
		}

		if (!VALID_ARTIFACT_KINDS.has(artifact.kind)) {
			throw new ValidationError(
				`Artifact owner '${ownerId}' write failed: invalid kind '${artifact.kind}'. Supported kinds: 'trickplay', 'chapters', 'preview', 'waveform'.`,
				{ code: "artifact.invalid_request" },
			);
		}

		this.assertAllowedContentType(artifact.contentType, ownerId);

		const incomingBytes = contentByteSize(artifact.content);
		this.assertArtifactSize(artifact.content, ownerId);

		// Gate before any side effect: a rejected write must not run plugin hooks,
		// touch the media row or leave a file behind.
		const bytesAfterWrite = (await this.getStoredBytes(ownerId)) + incomingBytes;
		await options?.assertWithinQuota?.(ownerId, bytesAfterWrite, incomingBytes);

		const candidate = await pluginHookBus.runBeforeArtifactCreate({
			mediaFileId: artifact.mediaFileId,
			kind: artifact.kind,
			contentType: artifact.contentType,
			size: incomingBytes,
		});
		const normalizedArtifact = { ...artifact, kind: candidate.kind, contentType: candidate.contentType };

		const mediaFileExists = await mediaRepository.isExists({ primaryId: normalizedArtifact.mediaFileId });
		if (!mediaFileExists)
			throw new NotFoundError(`Artifact owner '${ownerId}' write failed: media file '${normalizedArtifact.mediaFileId}' was not found.`, {
				code: "artifact.not_found",
			});

		const id = crypto.randomUUID();
		const storageKey = `${normalizedArtifact.mediaFileId}/${id}`;
		const stableKey = createLocalStableKey({ namespace: "media-artifact", value: `${ownerId}:${storageKey}` });
		const mediaArtifactsDir = PathUtils.join(serverConfig.paths.artifacts, normalizedArtifact.mediaFileId);
		await DirUtils.create(mediaArtifactsDir);

		const storedRows = await writeFileWithRollback(this.storagePath(storageKey), normalizedArtifact.content, () =>
			databaseFactory
				.getClient()
				.insert(mediaArtifactsRepository.table)
				.values({
					id,
					mediaFileId: normalizedArtifact.mediaFileId,
					pluginId: ownerId,
					stableKey,
					kind: normalizedArtifact.kind,
					contentType: normalizedArtifact.contentType,
					storageKey,
				})
				.returning(),
		);

		const storedArtifact = storedRows[0];
		if (!storedArtifact)
			throw new InternalError(`Artifact owner '${ownerId}' write failed: artifact '${id}' could not be saved.`, {
				code: "artifact.save_failed",
			});

		// Only now are the bytes actually stored — a rejected or rolled-back write
		// must not poison the cached total.
		this.ownerByteTotals.set(ownerId, bytesAfterWrite);

		const publicArtifact = this.toPublicArtifact(storedArtifact);
		pluginEventBus.publish("artifact.created", {
			mediaFileId: normalizedArtifact.mediaFileId,
			artifactId: publicArtifact.id,
			artifactType: publicArtifact.kind,
		});

		return publicArtifact;
	}

	async deleteByMediaFileIdAndKind(mediaFileId: string, kind: string, ownerId?: string): Promise<number> {
		const artifacts = await mediaArtifactsRepository.findByMediaFileId(mediaFileId);
		// When scoped, an owner may only delete its own artifacts of that kind.
		const matching = artifacts.filter((a) => a.kind === kind && (ownerId === undefined || a.pluginId === ownerId));
		if (matching.length === 0) return 0;

		await forEachChunked(
			matching.map((artifact) => artifact.id),
			async (ids) => {
				await mediaArtifactsRepository.delete({ ids });
			},
		);
		await this.removeStorageFiles(matching.map((a) => a.storageKey));

		// Stored bytes shrank — the cached totals are stale.
		for (const artifact of matching) this.ownerByteTotals.delete(artifact.pluginId);

		return matching.length;
	}

	async findFile(mediaFileId: string, artifactId: string): Promise<{ artifact: PlaybackArtifact; file: Blob } | null> {
		const artifact = await mediaArtifactsRepository.findById(artifactId);
		if (!artifact || artifact.mediaFileId !== mediaFileId) return null;

		const artifactFile = file(this.storagePath(artifact.storageKey));
		if (!(await artifactFile.exists())) return null;

		return { artifact: this.toPublicArtifact(artifact), file: artifactFile };
	}

	/** Removes every artifact row and file an owner ever produced — used on plugin uninstall so no orphans remain. */
	async removeForOwner(ownerId: string): Promise<number> {
		const artifacts = await mediaArtifactsRepository.findByPluginId(ownerId);
		if (artifacts.length === 0) return 0;

		await forEachChunked(
			artifacts.map((artifact) => artifact.id),
			async (ids) => {
				await mediaArtifactsRepository.delete({ ids });
			},
		);
		await this.removeStorageFiles(artifacts.map((artifact) => artifact.storageKey));
		this.ownerByteTotals.delete(ownerId);

		return artifacts.length;
	}

	async removeStorageFiles(storageKeys: readonly string[]): Promise<void> {
		await PromiseUtils.mapConcurrent(storageKeys, serverConfig.plugins.artifacts.cleanupConcurrency, (storageKey) =>
			FileUtils.delete(this.storagePath(storageKey)),
		);
	}

	/** Stored bytes for one owner (cached; computed by stat'ing its files on a miss). */
	async getStoredBytes(ownerId: string): Promise<number> {
		return await this.ownerByteTotals.getOrSet(ownerId, async () => await this.computeOwnerByteTotal(ownerId));
	}

	/** Stored bytes for a single media file, used to decide whether regeneration can still fit. */
	async getMediaFileStoredBytes(mediaFileId: string, ownerId: string): Promise<number> {
		const artifacts = await mediaArtifactsRepository.findByMediaFileId(mediaFileId);
		const sizes = await PromiseUtils.mapConcurrent(
			artifacts.filter((artifact) => artifact.pluginId === ownerId),
			serverConfig.plugins.artifacts.cleanupConcurrency,
			(artifact) => FileUtils.getStats(this.storagePath(artifact.storageKey)),
		);

		return sizes.reduce((total, stats) => total + (stats?.size ?? 0), 0);
	}

	/**
	 * Drops cached per-owner byte totals after files were removed outside this
	 * service (scanner stale-artifact cleanup, media/metadata/library delete).
	 * Without it the cache keeps counting deleted bytes and later writes are
	 * rejected with a quota/budget error while the owner is under its limit.
	 */
	invalidateByteTotals(ownerIds?: readonly string[]): void {
		if (!ownerIds) {
			this.ownerByteTotals.clear();

			return;
		}

		for (const ownerId of ownerIds) this.ownerByteTotals.delete(ownerId);
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

	private assertAllowedContentType(contentType: string, ownerId: string): void {
		const allowed = serverConfig.plugins.artifacts.allowedContentTypes;
		if (!allowed.includes(contentType)) {
			throw new ValidationError(
				`Artifact owner '${ownerId}' write failed: content type '${contentType}' is not allowed. Supported: ${allowed.join(", ")}.`,
				{ code: "artifact.invalid_content_type" },
			);
		}
	}

	private assertArtifactSize(content: PlaybackArtifactWrite["content"], ownerId?: string): void {
		const size = contentByteSize(content);
		if (size > serverConfig.plugins.artifacts.maxSizeBytes) {
			const ownerPrefix = ownerId ? `Artifact owner '${ownerId}'` : "Artifact";
			throw new ValidationError(
				`${ownerPrefix} size (${(size / 1024 / 1024).toFixed(2)} MB) exceeds the maximum allowed limit of ${(serverConfig.plugins.artifacts.maxSizeBytes / 1024 / 1024).toFixed(2)} MB (${serverConfig.plugins.artifacts.maxSizeBytes} bytes).`,
				{ code: "artifact.too_large" },
			);
		}
	}

	/** Stats every stored file of one owner (bounded parallel). */
	private async computeOwnerByteTotal(ownerId: string): Promise<number> {
		const existing = await mediaArtifactsRepository.findByPluginId(ownerId);
		const sizes = await PromiseUtils.mapConcurrent(existing, serverConfig.plugins.artifacts.cleanupConcurrency, (artifact) =>
			FileUtils.getStats(this.storagePath(artifact.storageKey)),
		);

		return sizes.reduce((total, stats) => total + (stats?.size ?? 0), 0);
	}
}

export const mediaArtifactsService = new MediaArtifactsService();

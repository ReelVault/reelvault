import { join } from "node:path";
import { type PlaybackArtifact, type PlaybackArtifactKind, type PlaybackArtifactWrite, playbackArtifactKinds } from "@reelvault/sdk/common";
import type { ArtifactCreationCandidate } from "@reelvault/sdk/plugin";
import { file } from "bun";
import { serverConfig } from "@/config/server/server.config";
import type { InferTable } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import { contentByteSize, writeFileWithRollback } from "@/plugins/shared/plugin.file-record.utils";
import { mediaArtifactsRepository } from "@/repositories/media-artifacts.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { pluginHookBus } from "@/system/extensions/plugin.hooks";
import { KeyedMutex } from "@/utils/concurrency.utils";
import { createDirectory } from "@/utils/directory.utils";
import { assertExists, DomainError } from "@/utils/domain.errors";
import { deleteFile, getFileStats } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { mapConcurrent } from "@/utils/promise.utils";

type MediaArtifactRow = InferTable<"mediaArtifacts">;

const PLAYBACK_ARTIFACT_KINDS_SET: ReadonlySet<string> = new Set(playbackArtifactKinds);

/** A `beforeArtifactCreate` hook may rename the kind, never move the artifact or change its size. */
function assertValidArtifactCandidate(original: ArtifactCreationCandidate, candidate: ArtifactCreationCandidate): void {
	if (
		candidate.mediaFileId !== original.mediaFileId ||
		candidate.size !== original.size ||
		!PLAYBACK_ARTIFACT_KINDS_SET.has(candidate.kind)
	) {
		throw new DomainError("validation", "beforeArtifactCreate returned an invalid artifact candidate", {
			code: "plugin.artifact_candidate_invalid",
		});
	}
}

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

/** The stored artifact kinds; a plugin may ask for a kind the store does not know. */
function toArtifactKind(kind: string): PlaybackArtifactKind | undefined {
	return playbackArtifactKinds.find((candidate) => candidate === kind);
}

/**
 * Shared playback-artifact store (table `media_artifacts`, `data/artifacts/`).
 * Both built-in generators and plugins write here; "plugin artifact" naming
 * only survives at the plugin capability boundary.
 */
class MediaArtifactsService {
	readonly serviceName = "MediaArtifactsService";
	readonly logger = createLogger("MediaArtifactsService");

	/**
	 * Per-owner stored bytes. The artifacts table has no size column, so the
	 * total comes from stat'ing every stored file; trickplay writes dozens of
	 * sprites per title, and recomputing per write made that O(writes x files).
	 * Invalidated on every delete path (the only way stored bytes shrink).
	 */
	private readonly ownerByteTotals = new MemoryCache<number>({ ttlMs: -1, maxSize: 64, name: "artifact-owner-totals" });
	/** Per-owner write serialisation for the quota check-then-write window. */
	private readonly writeLocks = new KeyedMutex();

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
			throw new DomainError("validation", `Artifact owner '${ownerId}' write failed: artifact must be an object.`, {
				code: "artifact.invalid_request",
			});
		}

		if (!artifact.mediaFileId || typeof artifact.mediaFileId !== "string") {
			throw new DomainError("validation", `Artifact owner '${ownerId}' write failed: missing or invalid 'mediaFileId'.`, {
				code: "artifact.invalid_request",
			});
		}

		if (!VALID_ARTIFACT_KINDS.has(artifact.kind)) {
			throw new DomainError(
				"validation",
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

		const original = { mediaFileId: artifact.mediaFileId, kind: artifact.kind, contentType: artifact.contentType, size: incomingBytes };
		const candidate = await pluginHookBus.run("beforeArtifactCreate", original);
		assertValidArtifactCandidate(original, candidate);
		// A hook may normalize the type, but only to another one the store serves.
		this.assertAllowedContentType(candidate.contentType, ownerId);
		const normalizedArtifact = { ...artifact, kind: candidate.kind, contentType: candidate.contentType };

		const mediaFileExists = await mediaRepository.isExists({ primaryId: normalizedArtifact.mediaFileId });
		assertExists(
			mediaFileExists,
			"Media file",
			normalizedArtifact.mediaFileId,
			new DomainError(
				"not_found",
				`Artifact owner '${ownerId}' write failed: media file '${normalizedArtifact.mediaFileId}' was not found.`,
				{ code: "artifact.not_found" },
			),
		);

		const id = crypto.randomUUID();
		const storageKey = `${normalizedArtifact.mediaFileId}/${id}`;
		const stableKey = createLocalStableKey({ namespace: "media-artifact", value: `${ownerId}:${storageKey}` });
		const mediaArtifactsDir = join(serverConfig.paths.artifacts, normalizedArtifact.mediaFileId);
		await createDirectory(mediaArtifactsDir);

		const storedRows = await writeFileWithRollback(this.storagePath(storageKey), normalizedArtifact.content, () =>
			mediaArtifactsRepository.insertReturning({
				values: {
					id,
					mediaFileId: normalizedArtifact.mediaFileId,
					pluginId: ownerId,
					stableKey,
					kind: normalizedArtifact.kind,
					contentType: normalizedArtifact.contentType,
					storageKey,
				},
			}),
		);

		const storedArtifact = storedRows[0];
		if (!storedArtifact)
			throw new DomainError("internal", `Artifact owner '${ownerId}' write failed: artifact '${id}' could not be saved.`, {
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

	/** Artifact rows per owner and kind, for the admin overview. */
	async countByOwnerAndKind(): Promise<Array<{ pluginId: string; kind: string; count: number }>> {
		return await mediaArtifactsRepository.countByOwnerAndKind();
	}

	/** Artifacts `deleteByMediaFileIdAndKind` would remove with the same filters; nothing is removed. */
	async countByMediaFileIdAndKind(mediaFileId: string, kind: string, ownerId?: string): Promise<number> {
		const artifactKind = toArtifactKind(kind);
		if (!artifactKind) return 0;

		return await mediaArtifactsRepository.countByMediaFileIdAndKind(mediaFileId, artifactKind, ownerId);
	}

	async deleteByMediaFileIdAndKind(mediaFileId: string, kind: string, ownerId?: string): Promise<number> {
		const artifactKind = toArtifactKind(kind);
		if (!artifactKind) return 0;

		// When scoped, an owner may only delete its own artifacts of that kind.
		const matching = await mediaArtifactsRepository.findByMediaFileIdAndKind(mediaFileId, artifactKind, ownerId);
		if (matching.length === 0) return 0;

		await this.deleteArtifacts(matching);

		return matching.length;
	}

	/**
	 * Removes the artifacts of several files in one read and one delete batch —
	 * a bulk request over many files used to read and delete them file by file.
	 * Returns how many artifacts were removed and which files carried them.
	 */
	async deleteByMediaFileIdsAndKind(
		mediaFileIds: readonly string[],
		kind: string,
		ownerId?: string,
	): Promise<{ artifacts: number; mediaFileIds: string[] }> {
		const artifactKind = toArtifactKind(kind);
		if (!artifactKind) return { artifacts: 0, mediaFileIds: [] };

		const matching = await mediaArtifactsRepository.findByMediaFileIdsAndKind(mediaFileIds, artifactKind, ownerId);
		if (matching.length === 0) return { artifacts: 0, mediaFileIds: [] };

		await this.deleteArtifacts(matching);

		return { artifacts: matching.length, mediaFileIds: [...new Set(matching.map((artifact) => artifact.mediaFileId))] };
	}

	/** Which of the given files carry artifacts of that kind, and how many — one read, not a row read per file. */
	async countByMediaFileIdsAndKind(
		mediaFileIds: readonly string[],
		kind: string,
		ownerId?: string,
	): Promise<{ artifacts: number; mediaFileIds: string[] }> {
		if (mediaFileIds.length === 0) return { artifacts: 0, mediaFileIds: [] };

		const artifactKind = toArtifactKind(kind);
		if (!artifactKind) return { artifacts: 0, mediaFileIds: [] };

		const matching = await mediaArtifactsRepository.findByMediaFileIdsAndKind(mediaFileIds, artifactKind, ownerId);

		return { artifacts: matching.length, mediaFileIds: [...new Set(matching.map((artifact) => artifact.mediaFileId))] };
	}

	private async deleteArtifacts(matching: Array<{ id: string; storageKey: string; pluginId: string }>): Promise<void> {
		await forEachChunked(
			matching.map((artifact) => artifact.id),
			async (ids) => {
				await mediaArtifactsRepository.delete({ ids });
			},
		);
		await this.removeStorageFiles(matching.map((a) => a.storageKey));

		// Stored bytes shrank — the cached totals are stale.
		for (const artifact of matching) this.ownerByteTotals.delete(artifact.pluginId);
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
		await mapConcurrent(storageKeys, serverConfig.plugins.artifacts.cleanupConcurrency, (storageKey) =>
			deleteFile(this.storagePath(storageKey)),
		);
	}

	/** Stored bytes for one owner (cached; computed by stat'ing its files on a miss). */
	async getStoredBytes(ownerId: string): Promise<number> {
		return await this.ownerByteTotals.getOrSet(ownerId, async () => await this.computeOwnerByteTotal(ownerId));
	}

	/** Stored bytes for a single media file, used to decide whether regeneration can still fit. */
	async getMediaFileStoredBytes(mediaFileId: string, ownerId: string): Promise<number> {
		const artifacts = await mediaArtifactsRepository.findByMediaFileId(mediaFileId);

		return await this.sumStoredBytes(artifacts.filter((artifact) => artifact.pluginId === ownerId));
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
		return join(serverConfig.paths.artifacts, storageKey);
	}

	private assertAllowedContentType(contentType: string, ownerId: string): void {
		const allowed = serverConfig.plugins.artifacts.allowedContentTypes;
		if (!allowed.includes(contentType)) {
			throw new DomainError(
				"validation",
				`Artifact owner '${ownerId}' write failed: content type '${contentType}' is not allowed. Supported: ${allowed.join(", ")}.`,
				{ code: "artifact.invalid_content_type" },
			);
		}
	}

	private assertArtifactSize(content: PlaybackArtifactWrite["content"], ownerId?: string): void {
		const size = contentByteSize(content);
		if (size > serverConfig.plugins.artifacts.maxSizeBytes) {
			const ownerPrefix = ownerId ? `Artifact owner '${ownerId}'` : "Artifact";
			throw new DomainError(
				"validation",
				`${ownerPrefix} size (${(size / 1024 / 1024).toFixed(2)} MB) exceeds the maximum allowed limit of ${(serverConfig.plugins.artifacts.maxSizeBytes / 1024 / 1024).toFixed(2)} MB (${serverConfig.plugins.artifacts.maxSizeBytes} bytes).`,
				{ code: "artifact.too_large" },
			);
		}
	}

	/** Stats every stored file of one owner (bounded parallel). */
	private async computeOwnerByteTotal(ownerId: string): Promise<number> {
		return await this.sumStoredBytes(await mediaArtifactsRepository.findByPluginId(ownerId));
	}

	/** Sums the on-disk size of the given artifact rows (bounded parallel). */
	private async sumStoredBytes(artifacts: readonly MediaArtifactRow[]): Promise<number> {
		const sizes = await mapConcurrent(artifacts, serverConfig.plugins.artifacts.cleanupConcurrency, (artifact) =>
			getFileStats(this.storagePath(artifact.storageKey)),
		);

		return sizes.reduce((total, stats) => total + (stats?.size ?? 0), 0);
	}
}

export const mediaArtifactsService = new MediaArtifactsService();

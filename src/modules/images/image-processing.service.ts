import {
	type ImageOwnerTarget,
	type ImageProcess,
	imageRepository,
	type PersistedImageInput,
} from "@/database/repositories/images.repository";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { BatchGarbageCollector } from "@/utils/gc.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import type { UploadedImage } from "./image-upload.service";
import { type ImageDownloadPipeline, imageDownloadPipeline } from "./processing/image-download.pipeline";

interface ServiceDependencies {
	getMetadataTarget: (metadataId: string, type: ImageProcess["type"]) => Promise<ImageOwnerTarget>;
	replaceMetadataImage: (metadataId: string, type: ImageProcess["type"], image: PersistedImageInput) => Promise<void>;
	getSeasonTarget: (metadataId: string, seasonId: string) => Promise<ImageOwnerTarget>;
	replaceSeasonImage: (metadataId: string, seasonId: string, image: PersistedImageInput) => Promise<void>;
	getEpisodeTarget: (metadataId: string, episodeId: string) => Promise<ImageOwnerTarget>;
	replaceEpisodeImage: (metadataId: string, episodeId: string, image: PersistedImageInput) => Promise<void>;
	getPersonTarget: (personId: string) => Promise<ImageOwnerTarget>;
	replacePersonImage: (personId: string, image: PersistedImageInput) => Promise<void>;
	getProfileAvatarTarget: (profileId: string) => Promise<ImageOwnerTarget>;
	replaceProfileAvatar: (profileId: string, image: PersistedImageInput) => Promise<{ imageId: string; avatarUrl: string }>;
	fileExists: (path: string) => Promise<boolean>;
	getSharpConcurrency: () => number;
	downloadAndPrepare: ImageDownloadPipeline["downloadAndPrepare"];
	prepareLocalArtwork: ImageDownloadPipeline["prepareLocalArtwork"];
	placeAtStablePath: ImageDownloadPipeline["placeAtStablePath"];
}

const defaultDependencies: ServiceDependencies = {
	getMetadataTarget: (metadataId, type) => imageRepository.getMetadataTarget(metadataId, type),
	replaceMetadataImage: (metadataId, type, image) => imageRepository.replaceMetadataImage(metadataId, type, image),
	getSeasonTarget: (metadataId, seasonId) => imageRepository.getSeasonTarget(metadataId, seasonId),
	replaceSeasonImage: (metadataId, seasonId, image) => imageRepository.replaceSeasonImage(metadataId, seasonId, image),
	getEpisodeTarget: (metadataId, episodeId) => imageRepository.getEpisodeTarget(metadataId, episodeId),
	replaceEpisodeImage: (metadataId, episodeId, image) => imageRepository.replaceEpisodeImage(metadataId, episodeId, image),
	getPersonTarget: (personId) => imageRepository.getPersonTarget(personId),
	replacePersonImage: (personId, image) => imageRepository.replacePersonImage(personId, image),
	getProfileAvatarTarget: (profileId) => imageRepository.getProfileAvatarTarget(profileId),
	replaceProfileAvatar: (profileId, image) => imageRepository.replaceProfileAvatar(profileId, image),
	fileExists: (path) => FileUtils.exists(path),
	getSharpConcurrency: () => systemResourcesService.getSharpConcurrency(),
	downloadAndPrepare: (url, target, variant, imageType, signal) =>
		imageDownloadPipeline.downloadAndPrepare(url, target, variant, imageType, signal),
	prepareLocalArtwork: (sourcePath, target, variant, imageType, signal) =>
		imageDownloadPipeline.prepareLocalArtwork(sourcePath, target, variant, imageType, signal),
	placeAtStablePath: (localPath, source) => imageDownloadPipeline.placeAtStablePath(localPath, source),
};

export class ImageProcessingService extends BaseService {
	private readonly gc = new BatchGarbageCollector();
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("ImageProcessingService");
		this.dependencies = dependencies;
	}

	async processMetadata(metadataId: string, images: ImageProcess[], force = false, signal?: AbortSignal) {
		return await this.safeExecute(
			"processMetadata",
			async () => {
				await PromiseUtils.mapConcurrent(
					images,
					// Each item is a sharp decode+encode — derive from measured capacity.
					this.dependencies.getSharpConcurrency,
					async (image) => {
						throwIfAborted(signal);
						if (!image.url) return;

						// A single dead provider URL must not abort the batch — the other
						// images are still valid and get persisted.
						try {
							await this.syncOwnerImage({
								url: image.url,
								force,
								variant: image.type,
								imageType: image.type,
								signal,
								fetchTarget: () => this.dependencies.getMetadataTarget(metadataId, image.type),
								replace: (persisted) => this.dependencies.replaceMetadataImage(metadataId, image.type, persisted),
							});
						} catch (error) {
							if (signal?.aborted) throw error;

							this.logger.warn("Metadata image failed — skipping it, continuing with the rest", {
								metadataId,
								imageType: image.type,
								error: errorMessage(error),
							});
						}
					},
					signal,
				);
			},
			{ logContext: { metadataId } },
		);
	}

	async replaceMetadataImage(metadataId: string, type: ImageProcess["type"], url: string, signal?: AbortSignal) {
		return await this.safeExecute(
			"replaceMetadataImage",
			() =>
				this.persistOwnerImage({
					signal,
					fetchTarget: () => this.dependencies.getMetadataTarget(metadataId, type),
					persist: (target) => this.dependencies.downloadAndPrepare(url, { ...target, currentLocalPath: undefined }, type, type, signal),
					replace: (persisted) => this.dependencies.replaceMetadataImage(metadataId, type, persisted),
					collectGarbage: true,
				}),
			{ logContext: { metadataId, type } },
		);
	}

	/** Replaces poster and/or backdrop from a provider result, skipping absent paths. */
	async replaceProviderArtwork(
		metadataId: string,
		artwork: { posterPath?: string | null | undefined; backdropPath?: string | null | undefined },
		signal?: AbortSignal,
	): Promise<void> {
		await Promise.all([
			artwork.posterPath ? this.replaceMetadataImage(metadataId, "poster", artwork.posterPath, signal) : Promise.resolve(),
			artwork.backdropPath ? this.replaceMetadataImage(metadataId, "backdrop", artwork.backdropPath, signal) : Promise.resolve(),
		]);
	}

	async replaceMetadataImageWithUpload(metadataId: string, type: ImageProcess["type"], uploaded: UploadedImage) {
		return await this.safeExecute(
			"replaceMetadataImageWithUpload",
			() =>
				this.persistOwnerImage({
					fetchTarget: () => this.dependencies.getMetadataTarget(metadataId, type),
					persist: (target) => this.prepareUpload(uploaded, target, type),
					replace: (persisted) => this.dependencies.replaceMetadataImage(metadataId, type, persisted),
				}),
			{ logContext: { metadataId, type } },
		);
	}

	/** Downloads a remote avatar URL through the same persist path as uploads (avatar variant, square 512). */
	async replaceProfileAvatarFromUrl(profileId: string, url: string): Promise<{ imageId: string; avatarUrl: string }> {
		return await this.safeExecute(
			"replaceProfileAvatarFromUrl",
			() =>
				this.persistOwnerImage({
					fetchTarget: () => this.dependencies.getProfileAvatarTarget(profileId),
					persist: (target) => this.dependencies.downloadAndPrepare(url, target, "avatar", "avatar"),
					replace: (persisted) => this.dependencies.replaceProfileAvatar(profileId, persisted),
				}),
			{ logContext: { profileId } },
		);
	}

	async replaceProfileAvatarWithUpload(profileId: string, uploaded: UploadedImage): Promise<{ imageId: string; avatarUrl: string }> {
		return await this.safeExecute(
			"replaceProfileAvatarWithUpload",
			() =>
				this.persistOwnerImage({
					fetchTarget: () => this.dependencies.getProfileAvatarTarget(profileId),
					persist: (target) => this.prepareUpload(uploaded, target, "avatar"),
					replace: (persisted) => this.dependencies.replaceProfileAvatar(profileId, persisted),
				}),
			{ logContext: { profileId } },
		);
	}

	async processSeason(
		input: { metadataId: string; seasonId: string; imagesUrl: string; force?: boolean | undefined },
		signal?: AbortSignal,
	) {
		if (!input.imagesUrl) return;

		return await this.safeExecute(
			"processSeason",
			async () => {
				await this.syncOwnerImage({
					url: input.imagesUrl,
					force: input.force === true,
					variant: "poster",
					imageType: "poster",
					signal,
					fetchTarget: () => this.dependencies.getSeasonTarget(input.metadataId, input.seasonId),
					replace: (persisted) => this.dependencies.replaceSeasonImage(input.metadataId, input.seasonId, persisted),
				});
			},
			{ logContext: { seasonId: input.seasonId } },
		);
	}

	async processEpisode(
		input: { metadataId: string; episodeId: string; imagesUrl: string; force?: boolean | undefined },
		signal?: AbortSignal,
	) {
		if (!input.imagesUrl) return;

		return await this.safeExecute(
			"processEpisode",
			async () => {
				await this.syncOwnerImage({
					url: input.imagesUrl,
					force: input.force === true,
					variant: "backdrop",
					imageType: "poster",
					signal,
					fetchTarget: () => this.dependencies.getEpisodeTarget(input.metadataId, input.episodeId),
					replace: (persisted) => this.dependencies.replaceEpisodeImage(input.metadataId, input.episodeId, persisted),
				});
			},
			{ logContext: { episodeId: input.episodeId } },
		);
	}

	async processPerson(personId: string, imagesUrl: string, force = false, signal?: AbortSignal) {
		if (!imagesUrl) return;

		return await this.safeExecute(
			"processPerson",
			async () => {
				await this.syncOwnerImage({
					url: imagesUrl,
					force,
					variant: "poster",
					imageType: "profile",
					signal,
					fetchTarget: () => this.dependencies.getPersonTarget(personId),
					replace: (persisted) => this.dependencies.replacePersonImage(personId, persisted),
				});
			},
			{ logContext: { personId } },
		);
	}

	/** Fetches the owner target, persists one image and hands it to the owner
	 * repository; `collectGarbage` mirrors the callers that tick the batch GC. */
	private async persistOwnerImage<T>({
		signal,
		fetchTarget,
		persist,
		replace,
		collectGarbage = false,
	}: {
		signal?: AbortSignal | undefined;
		fetchTarget: () => Promise<ImageOwnerTarget>;
		persist: (target: ImageOwnerTarget) => Promise<PersistedImageInput>;
		replace: (persisted: PersistedImageInput) => Promise<T>;
		collectGarbage?: boolean | undefined;
	}): Promise<T> {
		throwIfAborted(signal);
		const target = await fetchTarget();
		const persisted = await persist(target);
		const result = await replace(persisted);
		if (collectGarbage) this.gc.tick();

		return result;
	}

	private async syncOwnerImage({
		url,
		force,
		variant,
		imageType,
		signal,
		fetchTarget,
		replace,
	}: {
		url: string;
		force: boolean;
		variant: "poster" | "backdrop";
		imageType: string;
		signal?: AbortSignal | undefined;
		fetchTarget: () => Promise<ImageOwnerTarget>;
		replace: (persisted: PersistedImageInput) => Promise<void>;
	}): Promise<void> {
		throwIfAborted(signal);
		const target = await fetchTarget();
		if (!force && target.currentLocalPath && (await this.dependencies.fileExists(target.currentLocalPath))) return;

		// Sidecar artwork arrives as local absolute paths; provider art as URLs.
		const persisted = PathUtils.isAbsolute(url)
			? await this.dependencies.prepareLocalArtwork(url, target, variant, imageType, signal)
			: await this.dependencies.downloadAndPrepare(url, target, variant, imageType, signal);
		await replace(persisted);
		this.gc.tick();
	}

	private async prepareUpload(uploaded: UploadedImage, target: ImageOwnerTarget, imageType: string): Promise<PersistedImageInput> {
		const placed = await this.dependencies.placeAtStablePath(uploaded.localPath, {
			ownerStableKey: target.ownerStableKey,
			imageType,
			sourceHash: uploaded.sourceHash,
		});

		return { ...uploaded, ...placed };
	}
}

export const imageProcessingService = new ImageProcessingService();

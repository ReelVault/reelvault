import { readFile, rename } from "node:fs/promises";
import type { ImageOwnerTarget, PersistedImageInput } from "@/database/repositories/images.repository";
import { getImageMetadata, type OptimizedImageResult, optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import type { SharpImageOptions } from "@/integrations/sharp/sharp.types";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { createHash } from "@/utils/crypto.utils";
import { DirUtils } from "@/utils/directory.utils";
import { errorMessage, InternalError, ValidationError } from "@/utils/errors";
import { createTempPath, FileUtils } from "@/utils/file.utils";
import { createImageStableKey, createImageStoragePath } from "@/utils/image-storage.utils";
import { PathUtils } from "@/utils/path.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { getContentType } from "./content-types";

interface ServiceDependencies {
	download: typeof FileUtils.download;
	readLocalFile: (path: string) => Promise<Buffer>;
	getImageMetadata: (filePath: string) => Promise<{ format: string }>;
	optimizeImageWithInfo: (input: string, options: SharpImageOptions, signal?: AbortSignal) => Promise<OptimizedImageResult>;
	writeFile: (path: string, content: Buffer) => Promise<boolean>;
	deleteFile: (path: string) => Promise<boolean>;
	fileExists: (path: string) => Promise<boolean>;
	renameFile: (from: string, to: string) => Promise<void>;
	createDirectory: (path: string) => Promise<unknown>;
	resolveVariant: (variant: "poster" | "backdrop" | "avatar") => SharpImageOptions;
	imageTmpPath: () => string;
	imagesRoot: () => string;
}

const defaultDependencies: ServiceDependencies = {
	download: (url, destination, options) => FileUtils.download(url, destination, options),
	readLocalFile: (path) => readFile(path),
	getImageMetadata: (filePath) => getImageMetadata(filePath),
	optimizeImageWithInfo: (input, options, signal) => optimizeImageWithInfo(input, options, signal),
	writeFile: (path, content) => FileUtils.write(path, content),
	deleteFile: (path) => FileUtils.delete(path),
	fileExists: (path) => FileUtils.exists(path),
	renameFile: (from, to) => rename(from, to),
	createDirectory: (path) => DirUtils.create(path),
	resolveVariant: (variant) => serverConfig.images.variants[variant],
	imageTmpPath: () => serverConfig.paths.imageTmp,
	imagesRoot: () => serverConfig.paths.images,
};

export class ImageDownloadPipeline extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("ImageDownloadPipeline");
		this.dependencies = dependencies;
	}

	async downloadAndPrepare(
		url: string,
		target: ImageOwnerTarget,
		variant: "poster" | "backdrop" | "avatar",
		imageType: string,
		signal?: AbortSignal,
	): Promise<PersistedImageInput> {
		throwIfAborted(signal);
		const temporaryPath = this.createTemporaryImagePath();
		const source = await this.downloadAndGetInfo(url, temporaryPath, variant, signal);
		const placed = await this.placeAtStablePath(temporaryPath, {
			ownerStableKey: target.ownerStableKey,
			imageType,
			sourceHash: source.sourceHash,
		});

		return { ...source, ...placed };
	}

	/** Same optimize+persist flow as downloads, but the source is a local file (sidecar artwork). */
	async prepareLocalArtwork(
		sourceFilePath: string,
		target: ImageOwnerTarget,
		variant: "poster" | "backdrop" | "avatar",
		imageType: string,
		signal?: AbortSignal,
	): Promise<PersistedImageInput> {
		throwIfAborted(signal);
		const temporaryPath = this.createTemporaryImagePath();
		const source = await this.copyAndGetInfo(sourceFilePath, temporaryPath, variant, signal);
		const placed = await this.placeAtStablePath(temporaryPath, {
			ownerStableKey: target.ownerStableKey,
			imageType,
			sourceHash: source.sourceHash,
		});

		return { ...source, ...placed };
	}

	async placeAtStablePath(
		localPath: string,
		source: { ownerStableKey: string; imageType: string; sourceHash: string },
	): Promise<{ localPath: string; stableKey: string }> {
		const stableKey = createImageStableKey(source);

		return { localPath: await this.moveToStablePath(localPath, stableKey, source.imageType), stableKey };
	}

	private createTemporaryImagePath(): string {
		return PathUtils.join(this.dependencies.imageTmpPath(), `${crypto.randomUUID()}.webp`);
	}

	private async moveToStablePath(localPath: string, stableKey: string, imageType?: string): Promise<string> {
		const stablePath = createImageStoragePath({ root: this.dependencies.imagesRoot(), stableKey, imageType });
		if (localPath === stablePath) return stablePath;

		await this.dependencies.createDirectory(PathUtils.getDirName(stablePath));
		if (await this.dependencies.fileExists(stablePath)) {
			await this.dependencies.deleteFile(localPath);

			return stablePath;
		}

		try {
			await this.dependencies.renameFile(localPath, stablePath);
		} catch (error) {
			throw new InternalError(`Cannot move image to stable path: ${stablePath}`, { cause: error });
		}

		return stablePath;
	}

	private async copyAndGetInfo(
		sourceFilePath: string,
		localPath: string,
		variant: "poster" | "backdrop" | "avatar",
		signal?: AbortSignal,
	): Promise<Omit<PersistedImageInput, "localPath" | "stableKey">> {
		throwIfAborted(signal);
		await this.dependencies.createDirectory(PathUtils.getDirName(localPath));
		await this.dependencies.deleteFile(localPath);

		const sourcePath = createTempPath(localPath, ".source.tmp");
		const optimizedPath = createTempPath(localPath, ".optimized.tmp");
		try {
			await this.dependencies.writeFile(sourcePath, await this.dependencies.readLocalFile(sourceFilePath));
			const metadata = await this.dependencies.getImageMetadata(sourcePath);
			if (metadata.format === "") throw new ValidationError(`Local file has no recognized image format: ${sourceFilePath}`);

			getContentType(metadata.format);

			throwIfAborted(signal);
			const { data, info } = await this.dependencies.optimizeImageWithInfo(sourcePath, this.dependencies.resolveVariant(variant), signal);
			if (!(await this.dependencies.writeFile(optimizedPath, data))) throw new InternalError(`Cannot write optimized image: ${localPath}`);

			await this.dependencies.renameFile(optimizedPath, localPath);

			const sourceHash = createHash("sha256").update(data).digest("hex");

			return {
				contentType: "image/webp",
				width: info.width,
				height: info.height,
				fileSize: info.size,
				sourceHash,
			};
		} finally {
			await this.dependencies.deleteFile(sourcePath);
			await this.dependencies.deleteFile(optimizedPath);
		}
	}

	private async downloadAndGetInfo(
		url: string,
		localPath: string,
		variant: "poster" | "backdrop" | "avatar",
		signal?: AbortSignal,
	): Promise<Omit<PersistedImageInput, "localPath" | "stableKey">> {
		throwIfAborted(signal);
		await this.dependencies.createDirectory(PathUtils.getDirName(localPath));
		await this.dependencies.deleteFile(localPath);

		const sourcePath = createTempPath(localPath, ".source.tmp");
		const optimizedPath = createTempPath(localPath, ".optimized.tmp");
		try {
			let downloadError: string | undefined;
			const downloaded = await this.dependencies.download(url, sourcePath, {
				signal,
				validate: async (temporaryPath) => {
					throwIfAborted(signal);
					const metadata = await this.dependencies.getImageMetadata(temporaryPath);
					const format: string | undefined = metadata.format;
					if (format === "") throw new ValidationError("Downloaded file has no recognized image format");

					getContentType(format);
				},
				onError: (error) => {
					downloadError = errorMessage(error);
				},
			});
			if (!downloaded) throw new ValidationError(`Cannot download a valid image from ${url}${downloadError ? `: ${downloadError}` : ""}`);

			throwIfAborted(signal);
			const { data, info } = await this.dependencies.optimizeImageWithInfo(sourcePath, this.dependencies.resolveVariant(variant), signal);
			if (!(await this.dependencies.writeFile(optimizedPath, data))) throw new InternalError(`Cannot write optimized image: ${localPath}`);

			await this.dependencies.renameFile(optimizedPath, localPath);

			const sourceHash = createHash("sha256").update(data).digest("hex");

			return {
				contentType: "image/webp",
				width: info.width,
				height: info.height,
				fileSize: info.size,
				sourceHash,
			};
		} finally {
			await this.dependencies.deleteFile(sourcePath);
			await this.dependencies.deleteFile(optimizedPath);
		}
	}
}

export const imageDownloadPipeline = new ImageDownloadPipeline();

import type { ImageQuery } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { imageRepository } from "@/repositories/images.repository";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { deleteFile, fileExists } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { imageOptimizationService, type OptimizedImage } from "./image-optimization.service";

interface ServiceDependencies {
	findForFileRead: (imageId: string) => Promise<{ localPath: string; contentType: string } | undefined>;
	deleteAndReturn: (imageId: string) => Promise<{ localPath: string } | undefined>;
	fileExists: (path: string) => Promise<boolean>;
	deleteFile: (path: string) => Promise<boolean>;
	getOptimizedImage: (sourcePath: string, request: ImageQuery, imageId?: string, signal?: AbortSignal) => Promise<OptimizedImage>;
}

const defaultDependencies: ServiceDependencies = {
	findForFileRead: (imageId) => imageRepository.findForFileRead(imageId),
	deleteAndReturn: (imageId) => imageRepository.deleteAndReturn(imageId),
	fileExists: (path) => fileExists(path),
	deleteFile: (path) => deleteFile(path),
	getOptimizedImage: (sourcePath, request, imageId, signal) =>
		imageOptimizationService.getOptimizedImage(sourcePath, request, imageId, signal),
};

export class ImagesService {
	readonly serviceName = "ImagesService";
	readonly logger = createLogger("ImagesService");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async getById(imageId: string): Promise<{ file: ReturnType<typeof bunFile>; localPath: string; contentType: string }> {
		return await runSafely(this, "getById", async () => {
			const image = await this.dependencies.findForFileRead(imageId);
			assertFound(image, "Image", imageId);
			const file = bunFile(image.localPath);
			if (!(await this.dependencies.fileExists(image.localPath)))
				throw new DomainError("not_found", `Image file not found: ${imageId}`, { code: "images.not_found" });

			return { file, localPath: image.localPath, contentType: image.contentType };
		});
	}

	async getOptimizedById(imageId: string, request: ImageQuery, signal?: AbortSignal) {
		return await runSafely(this, "getOptimizedById", async () => {
			const image = await this.getById(imageId);
			if (request.width === undefined && request.height === undefined && request.quality === undefined) {
				return { file: image.file, contentType: image.contentType, options: null };
			}

			const optimized = await this.dependencies.getOptimizedImage(image.localPath, request, imageId, signal);

			return { file: optimized.file, contentType: optimized.contentType, options: optimized.options };
		});
	}

	async delete(imageId: string): Promise<{ success: boolean }> {
		return await runSafely(this, "delete", async () => {
			const image = await this.dependencies.deleteAndReturn(imageId);

			assertFound(image, "Image", imageId);
			await this.dependencies.deleteFile(image.localPath);

			return { success: true };
		});
	}
}

export const imagesService = new ImagesService();

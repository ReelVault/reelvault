import type { ImageQuery } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { imageRepository } from "@/database/repositories/images.repository";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import type { OptimizedImage } from "./image-optimization.service";
import { imageOptimizationService } from "./image-optimization.service";

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
	fileExists: (path) => FileUtils.exists(path),
	deleteFile: (path) => FileUtils.delete(path),
	getOptimizedImage: (sourcePath, request, imageId, signal) =>
		imageOptimizationService.getOptimizedImage(sourcePath, request, imageId, signal),
};

export class ImagesService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("ImagesService");
		this.dependencies = dependencies;
	}

	async getById(imageId: string): Promise<{ file: ReturnType<typeof bunFile>; localPath: string; contentType: string }> {
		return await this.safeExecute("getById", async () => {
			const image = await this.dependencies.findForFileRead(imageId);
			this.assertExists(image, "Image", imageId);
			const file = bunFile(image.localPath);
			if (!(await this.dependencies.fileExists(image.localPath))) throw new NotFoundError(`Image file not found: ${imageId}`);

			return { file, localPath: image.localPath, contentType: image.contentType };
		});
	}

	async getOptimizedById(imageId: string, request: ImageQuery, signal?: AbortSignal) {
		return await this.safeExecute("getOptimizedById", async () => {
			const image = await this.getById(imageId);
			if (request.width === undefined && request.height === undefined && request.quality === undefined) {
				return { file: image.file, contentType: image.contentType, options: null };
			}

			const optimized = await this.dependencies.getOptimizedImage(image.localPath, request, imageId, signal);

			return { file: optimized.file, contentType: optimized.contentType, options: optimized.options };
		});
	}

	async delete(imageId: string): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			const image = await this.dependencies.deleteAndReturn(imageId);

			this.assertExists(image, "Image", imageId);
			await this.dependencies.deleteFile(image.localPath);

			return { success: true };
		});
	}
}

export const imagesService = new ImagesService();

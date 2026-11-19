import { dirname } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import { detectImageFormat } from "@/modules/images/image-format.utils";
import { createImageTemporaryPath } from "@/modules/images/image-temp-path.utils";
import { MIB } from "@/utils/bytes.utils";
import { createDirectory } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { writeFileAtomic } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { type OptimizedImageFields, toOptimizedImageFields } from "./optimized-image.utils";

type ImageUploadTarget =
	| { ownerType: "metadata"; ownerId: string; variant: "poster" | "backdrop" }
	| { ownerType: "profile"; ownerId: string; variant: "avatar" };

export interface UploadedImage extends OptimizedImageFields {
	localPath: string;
}

class ImageUploadService {
	readonly serviceName = "ImageUploadService";
	readonly logger = createLogger("ImageUploadService");

	async upload(file: File, target: ImageUploadTarget): Promise<UploadedImage> {
		if (file.size > serverConfig.images.maxUploadBytes) {
			throw new DomainError("validation", `Image upload exceeds the ${serverConfig.images.maxUploadBytes / MIB} MB limit`, {
				code: "images.upload_too_large",
				params: { maxBytes: serverConfig.images.maxUploadBytes, size: file.size },
			});
		}

		// The declared MIME type is client-controlled — the payload itself must
		// carry a known raster-image signature (SVG markup is rejected here).
		const source = Buffer.from(await file.arrayBuffer());
		if (!detectImageFormat(source))
			throw new DomainError("validation", "Uploaded file is not a supported raster image", { code: "images.unsupported_format" });

		const { data, info } = await optimizeImageWithInfo(source, serverConfig.images.variants[target.variant]);
		if (!(info.width && info.height)) {
			throw new DomainError("internal", "Optimized image is invalid", { code: "images.optimized_invalid" });
		}

		const localPath = createImageTemporaryPath(serverConfig.paths.imageTmp);
		await createDirectory(dirname(localPath));
		try {
			await writeFileAtomic(localPath, data);
		} catch (error) {
			throw new DomainError("internal", "Cannot write optimized image", { cause: error, code: "image.write_failed" });
		}

		return { localPath, ...toOptimizedImageFields({ data, info }) };
	}
}

export const imageUploadService = new ImageUploadService();

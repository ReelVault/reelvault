import { serverConfig } from "@/config/server/server.config";
import { optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import { detectImageFormat } from "@/modules/images/image-format.utils";
import { createHash } from "@/utils/crypto.utils";
import { createDirectory } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { writeFileAtomic } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { getDirName, joinPath } from "@/utils/path.utils";

type ImageUploadTarget =
	| { ownerType: "metadata"; ownerId: string; variant: "poster" | "backdrop" }
	| { ownerType: "profile"; ownerId: string; variant: "avatar" };

export interface UploadedImage {
	localPath: string;
	contentType: "image/webp";
	width: number;
	height: number;
	fileSize: number;
	sourceHash: string;
}

class ImageUploadService {
	readonly serviceName = "ImageUploadService";
	readonly logger = createLogger("ImageUploadService");

	async upload(file: File, target: ImageUploadTarget): Promise<UploadedImage> {
		if (file.size > serverConfig.images.maxUploadBytes) {
			throw new DomainError("validation", `Image upload exceeds the ${serverConfig.images.maxUploadBytes / 1024 / 1024} MB limit`, {
				code: "images.upload_too_large",
				params: { maxBytes: serverConfig.images.maxUploadBytes, size: file.size },
			});
		}

		// The declared MIME type is client-controlled — the payload itself must
		// carry a known raster-image signature (SVG markup is rejected here).
		const source = Buffer.from(await file.arrayBuffer());
		if (!detectImageFormat(source))
			throw new DomainError("validation", "Uploaded file is not a supported raster image", { code: "images.unsupported_format" });

		const localPath = this.createTemporaryImagePath();
		await createDirectory(getDirName(localPath));

		const { data, info } = await optimizeImageWithInfo(source, serverConfig.images.variants[target.variant]);

		try {
			await writeFileAtomic(localPath, data);
		} catch {
			throw new DomainError("internal", "Cannot write optimized image", { code: "image.write_failed" });
		}

		const optimizedData = data;
		const optimizedInfo = info;

		if (!(optimizedInfo.width && optimizedInfo.height)) {
			throw new DomainError("internal", "Optimized image is invalid", { code: "images.optimized_invalid" });
		}

		const sourceHash = createHash("sha256").update(optimizedData).digest("hex");

		return {
			localPath,
			contentType: "image/webp",
			width: optimizedInfo.width,
			height: optimizedInfo.height,
			fileSize: optimizedInfo.size,
			sourceHash,
		};
	}

	private createTemporaryImagePath(): string {
		return joinPath(serverConfig.paths.imageTmp, `${crypto.randomUUID()}.webp`);
	}
}

export const imageUploadService = new ImageUploadService();

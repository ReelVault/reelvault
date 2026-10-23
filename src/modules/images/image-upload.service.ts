import { dirname, join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import { detectImageFormat } from "@/modules/images/image-format.utils";
import { MIB } from "@/utils/bytes.utils";
import { createHash } from "@/utils/crypto.utils";
import { createDirectory } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { writeFileAtomic } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";

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

		const localPath = this.createTemporaryImagePath();
		// awaits: sequential — the target directory exists before the image is written there
		await createDirectory(dirname(localPath));

		const { data, info } = await optimizeImageWithInfo(source, serverConfig.images.variants[target.variant]);

		try {
			await writeFileAtomic(localPath, data);
		} catch (error) {
			throw new DomainError("internal", "Cannot write optimized image", { cause: error, code: "image.write_failed" });
		}

		if (!(info.width && info.height)) {
			throw new DomainError("internal", "Optimized image is invalid", { code: "images.optimized_invalid" });
		}

		const sourceHash = createHash("sha256").update(data).digest("hex");

		return {
			localPath,
			contentType: "image/webp",
			width: info.width,
			height: info.height,
			fileSize: info.size,
			sourceHash,
		};
	}

	private createTemporaryImagePath(): string {
		return join(serverConfig.paths.imageTmp, `${crypto.randomUUID()}.webp`);
	}
}

export const imageUploadService = new ImageUploadService();

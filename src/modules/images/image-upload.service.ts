import { optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import { detectImageFormat } from "@/modules/images/image-format.utils";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { createHash } from "@/utils/crypto.utils";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError, ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

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

class ImageUploadService extends BaseService {
	constructor() {
		super("ImageUploadService");
	}

	async upload(file: File, target: ImageUploadTarget): Promise<UploadedImage> {
		if (file.size > serverConfig.images.maxUploadBytes) {
			throw new ValidationError(`Image upload exceeds the ${serverConfig.images.maxUploadBytes / 1024 / 1024} MB limit`);
		}

		// The declared MIME type is client-controlled — the payload itself must
		// carry a known raster-image signature (SVG markup is rejected here).
		const source = Buffer.from(await file.arrayBuffer());
		if (!detectImageFormat(source))
			throw new ValidationError("Uploaded file is not a supported raster image", { code: "images.unsupported_format" });

		const localPath = this.createTemporaryImagePath();
		await DirUtils.create(PathUtils.getDirName(localPath));

		const { data, info } = await optimizeImageWithInfo(source, serverConfig.images.variants[target.variant]);

		try {
			await FileUtils.writeAtomic(localPath, data);
		} catch {
			throw new InternalError("Cannot write optimized image");
		}

		const optimizedData = data;
		const optimizedInfo = info;

		if (!(optimizedInfo.width && optimizedInfo.height)) {
			throw new InternalError("Optimized image is invalid");
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
		return PathUtils.join(serverConfig.paths.imageTmp, `${crypto.randomUUID()}.webp`);
	}
}

export const imageUploadService = new ImageUploadService();

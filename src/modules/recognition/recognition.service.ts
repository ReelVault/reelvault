import { BaseService } from "@/utils/base-service";
import { PathUtils } from "@/utils/path.utils";
import type { PathContext, RecognitionResult, RecognitionStrategy } from "./recognition.types";
import { MoviesBasicStrategy } from "./strategies/movies-basic.strategy";
import { MoviesCategorizedStrategy } from "./strategies/movies-categorized.strategy";
import { SeriesBasicStrategy } from "./strategies/series-basic.strategy";
import { SeriesCategorizedStrategy } from "./strategies/series-categorized.strategy";

class RecognitionService extends BaseService {
	private readonly strategies: readonly RecognitionStrategy[];

	constructor() {
		super("RecognitionService");
		this.strategies = [
			new SeriesCategorizedStrategy(), // 1. Try: series / season / file
			new SeriesBasicStrategy(), // 2. Try: series / file (S01E01)
			new MoviesCategorizedStrategy(), // 3. Try: movie / file
			new MoviesBasicStrategy(), // 4. Last resort: bare file
		];
	}

	recognize(filePath: string): RecognitionResult | null {
		const context = this.createPathContext(filePath);
		if (!context) return null;

		for (const strategy of this.strategies) {
			const result = strategy.recognize(context);
			if (result) {
				return result;
			}
		}

		this.logger.warn("No strategy recognized for file", { filePath: context.normalizedPath });

		return null;
	}

	private createPathContext(filePath: string): PathContext | null {
		const normalizedPath = PathUtils.normalize(filePath);
		const parts = normalizedPath.split("/").filter(Boolean);
		if (parts.length === 0) return null;

		return {
			rawPath: filePath,
			normalizedPath,
			parts,
			fileName: parts.at(-1) ?? "",
			parentFolder: parts[parts.length - 2],
			grandParentFolder: parts[parts.length - 3],
		};
	}
}

export const recognitionService = new RecognitionService();

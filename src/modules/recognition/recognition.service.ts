import { createLogger } from "@/utils/logger.utils";
import { normalizePath } from "@/utils/path.utils";
import type { PathContext, RecognitionResult, RecognitionStrategy } from "./recognition.types";
import { moviesBasicStrategy } from "./strategies/movies-basic.strategy";
import { moviesCategorizedStrategy } from "./strategies/movies-categorized.strategy";
import { seriesBasicStrategy } from "./strategies/series-basic.strategy";
import { seriesCategorizedStrategy } from "./strategies/series-categorized.strategy";

class RecognitionService {
	readonly serviceName = "RecognitionService";
	readonly logger = createLogger("RecognitionService");

	private readonly strategies: readonly RecognitionStrategy[];

	constructor() {
		this.strategies = [
			seriesCategorizedStrategy, // 1. Try: series / season / file
			seriesBasicStrategy, // 2. Try: series / file (S01E01)
			moviesCategorizedStrategy, // 3. Try: movie / file
			moviesBasicStrategy, // 4. Last resort: bare file
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
		const normalizedPath = normalizePath(filePath);
		const parts = normalizedPath.split("/").filter(Boolean);
		if (parts.length === 0) return null;

		return {
			rawPath: filePath,
			normalizedPath,
			parts,
			fileName: parts.at(-1) ?? "",
			parentFolder: parts.at(-2),
			grandParentFolder: parts.at(-3),
		};
	}
}

export const recognitionService = new RecognitionService();

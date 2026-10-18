import type { PathContext, RecognitionResult, RecognitionStrategy } from "@/modules/recognition/recognition.types";
import { parseFileName } from "@/modules/recognition/utils/recognition.utils";

export class MoviesBasicStrategy implements RecognitionStrategy {
	recognize(ctx: PathContext): RecognitionResult | null {
		const { fileName } = ctx;
		if (!fileName) return null;

		const identity = parseFileName(fileName);
		if (!identity) return null;

		return {
			type: "movie",
			identity,
		};
	}
}

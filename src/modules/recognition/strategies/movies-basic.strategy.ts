import type { PathContext, RecognitionResult, RecognitionStrategy } from "../recognition.types";
import { parseFileName } from "../utils/recognition.utils";

export class MoviesBasicStrategy implements RecognitionStrategy {
	readonly name = "movies-basic";

	recognize(ctx: PathContext): RecognitionResult | null {
		const { fileName } = ctx;
		if (!fileName) return null;

		const identity = parseFileName(fileName);
		if (!identity) return null;

		return {
			type: "movie",
			identity,
			meta: {
				libraryStructure: this.name,
				rootPath: fileName,
			},
		};
	}
}

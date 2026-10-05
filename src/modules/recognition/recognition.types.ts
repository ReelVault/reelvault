import type { MediaIdentity } from "@reelvault/sdk/common";

export interface PathContext {
	readonly rawPath: string;
	readonly normalizedPath: string;
	readonly parts: readonly string[];
	readonly fileName: string;
	readonly parentFolder?: string | undefined;
	readonly grandParentFolder?: string | undefined;
}

export interface RecognitionResult {
	type: "movie" | "tv_show";
	identity: MediaIdentity;
}

export interface RecognitionStrategy {
	readonly name: string;
	recognize(context: PathContext): RecognitionResult | null;
}

type IgnoredAssetReason = "unsupported-artwork-type" | "external-nfo-reference" | "unknown-sidecar";

export interface IgnoredLocalAsset {
	readonly path: string;
	readonly fileName: string;
	readonly reason: IgnoredAssetReason;
}

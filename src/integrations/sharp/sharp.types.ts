import type { ImageQuality } from "@sdk/common/images";

export interface SharpImageOptions {
	width: number;
	height: number | null;
	quality: ImageQuality;
	effort?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | undefined;
	fit?: "inside" | "cover" | undefined;
	position?: "center" | "attention" | undefined;
	withoutEnlargement?: boolean | undefined;
}

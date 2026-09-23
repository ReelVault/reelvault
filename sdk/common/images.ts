export const IMAGE_SUPPORTED_WIDTHS = [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1000, 1080, 1200, 1500, 1920] as const;

export const IMAGE_SUPPORTED_HEIGHTS = [...IMAGE_SUPPORTED_WIDTHS] as const;

export const IMAGE_SUPPORTED_QUALITIES = [45, 60, 75, 85] as const;

export type ImageWidth = (typeof IMAGE_SUPPORTED_WIDTHS)[number];

export type ImageQuality = (typeof IMAGE_SUPPORTED_QUALITIES)[number];

export interface ImageQuery {
	width?: number | undefined;
	height?: number | undefined;
	quality?: number | undefined;
}

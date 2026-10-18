export const DOWNLOAD_QUALITIES = ["original", "1080p-high", "720p-mobile", "480p-low"] as const;
export type DownloadQuality = (typeof DOWNLOAD_QUALITIES)[number];

export const DOWNLOAD_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

import { serverConfig } from "@/config/server/server.config";
import { downloadsStorage } from "@/modules/downloads/downloads.ports";
import type { createLogger } from "@/utils/logger.utils";

export interface DownloadsServiceState {
	readonly serviceName: string;
	readonly logger: ReturnType<typeof createLogger>;
	/** Kill-switches for in-flight ffmpeg runs, keyed by download id. */
	readonly abortHandles: Map<string, () => void>;
}

/** Arguments of a state-taking service function, without the leading state parameter. */
export type WithoutState<F> = F extends (state: never, ...rest: infer R) => unknown ? R : never;

/** Options of one worker run: a progress sink, and the signal that stops ffmpeg. */
export interface DownloadRunOptions {
	updateProgress?: (percent: number) => Promise<void>;
	signal?: AbortSignal;
}

export async function getStorageQuota(profileId: string): Promise<{ maxBytes: number; usedBytes: number }> {
	return {
		maxBytes: serverConfig.downloads.maxStorageBytesPerProfile,
		usedBytes: await downloadsStorage().storageUsedByProfile(profileId),
	};
}

/** Fails a download whose source media file disappeared — retrying cannot bring it back. */
export async function failMissingSource(downloadId: string): Promise<void> {
	await downloadsStorage().update(downloadId, { status: "failed", errorText: "download.media_missing" });
}

import { env } from "@/config/env.config";
import { serverConstants } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";

/**
 * Resolves an ffmpeg/ffprobe binary path. A path saved in the admin UI wins,
 * then the environment fallback (set by the launchers of the bundled archives),
 * then the settings default (the command name, resolved through PATH).
 */
function resolveToolPath(key: "ffmpeg.path" | "ffprobe.path", envPath: string | undefined): string {
	const { value, isCustom } = systemSettingsStore.getWithMeta(key);
	if (isCustom) return value;

	const fromEnv = envPath?.trim();
	if (fromEnv) return fromEnv;

	return value;
}

/**
 * The HLS segment length is baked into every running transcode (segment names, playlists,
 * buffer maths), so changing it live would corrupt open sessions. It is read once, when
 * first needed after a server start, and a changed setting applies after a restart.
 */
let hlsSegmentDurationAtBoot: number | undefined;

/** Streaming, transcoding, FFmpeg/FFprobe, trickplay, artifacts and downloads. */
export const streamingConfig = {
	/** Streaming & Transcoding Engine */
	stream: {
		...serverConstants.stream,
		// First-playlist wait on a slow transcode core — scale, cap 2×.
		get playlistTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.playlistTimeoutMs);
		},
		get initialSegmentTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.initialSegmentTimeoutMs);
		},
		get seekSegmentTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.seekSegmentTimeoutMs);
		},
		get recoverySegmentTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.stream.recoverySegmentTimeoutMs);
		},
		get maxSessions() {
			return systemSettingsStore.get("stream.maxSessions");
		},
		get maxSessionsPerUser() {
			return systemSettingsStore.get("stream.maxSessionsPerUser");
		},
		get maxSoftwareTranscodes() {
			return systemSettingsStore.get("stream.maxSoftwareTranscodes");
		},
		get maxPerStreamBandwidthKbps() {
			return systemSettingsStore.get("stream.maxPerStreamBandwidthKbps");
		},
		get hlsMaxMuxingQueueSize() {
			return systemSettingsStore.get("stream.hlsMaxMuxingQueueSize");
		},
		get seekDebounceMs() {
			return systemSettingsStore.get("stream.seekDebounceMs");
		},
		get hlsSegmentDurationSeconds() {
			hlsSegmentDurationAtBoot ??= systemSettingsStore.get("stream.hlsSegmentDurationSeconds");

			return hlsSegmentDurationAtBoot;
		},
		get inactivityTimeoutMs() {
			return systemSettingsStore.get("stream.inactivityTimeoutMs");
		},
	},

	/** FFmpeg Transcoder & Hardware Acceleration */
	ffmpeg: {
		...serverConstants.ffmpeg,
		get path() {
			return resolveToolPath("ffmpeg.path", env.APP_FFMPEG_PATH);
		},
		get hwaccel() {
			return systemSettingsStore.get("ffmpeg.hwaccel");
		},
		get hwaccelDevice() {
			return systemSettingsStore.get("ffmpeg.hwaccelDevice");
		},
		get toneMapping() {
			return systemSettingsStore.get("ffmpeg.toneMapping");
		},
		get toneMapAlgorithm() {
			return systemSettingsStore.get("ffmpeg.toneMapAlgorithm");
		},
		get gracefulShutdownTimeoutMs() {
			return systemSettingsStore.get("ffmpeg.gracefulShutdownTimeoutMs");
		},
		get audioBitrateKbps() {
			return systemSettingsStore.get("ffmpeg.audioBitrateKbps");
		},
		get downmixToStereo() {
			return systemSettingsStore.get("ffmpeg.downmixToStereo");
		},
		get preset() {
			return systemSettingsStore.get("ffmpeg.preset");
		},
		get crf() {
			return systemSettingsStore.get("ffmpeg.crf");
		},
		get threads() {
			return systemSettingsStore.get("ffmpeg.threads");
		},
	},

	ffprobe: {
		...serverConstants.ffprobe,
		// Probing huge remuxes over slow storage on weak CPUs can exceed a fixed
		// minute — scale with measured core speed.
		get timeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.ffprobe.timeoutMs);
		},
		get path() {
			return resolveToolPath("ffprobe.path", env.APP_FFPROBE_PATH);
		},
	},

	/** Built-in trickplay (preview sprites) generation */
	trickplay: {
		get enabled() {
			return systemSettingsStore.get("trickplay.enabled");
		},
		get autoOnRefresh() {
			return systemSettingsStore.get("trickplay.autoOnRefresh");
		},
		get intervalSeconds() {
			return systemSettingsStore.get("trickplay.intervalSeconds");
		},
		get tileWidth() {
			return systemSettingsStore.get("trickplay.tileWidth");
		},
		get columns() {
			return systemSettingsStore.get("trickplay.columns");
		},
		get maxFramesPerFile() {
			return systemSettingsStore.get("trickplay.maxFramesPerFile");
		},
	},

	/** Core-generated playback artifacts (trickplay, future kinds) */
	artifacts: {
		get coreMaxStorageGb() {
			return systemSettingsStore.get("system.artifacts.coreMaxStorageGb");
		},
	},

	/** Built-in downloads (offline copies) */
	downloads: {
		get enabled() {
			return systemSettingsStore.get("downloads.enabled");
		},
		get maxStorageBytesPerProfile() {
			return systemSettingsStore.get("downloads.maxStorageBytesPerProfile");
		},
		get retentionDays() {
			return systemSettingsStore.get("downloads.retentionDays");
		},
		get maxConcurrentPerProfile() {
			return systemSettingsStore.get("downloads.maxConcurrentPerProfile");
		},
	},
};

import { serverConfig } from "@/config/server/server.config";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { type DetectedHwaccel, getCandidateHwaccels, resolveEffectiveHwaccel, SOFTWARE_HWACCEL } from "./capabilities/hwaccel.utils";
import {
	parseEncoderNames,
	parseFfmpegVersion,
	parseFilterNames,
	parseHwaccelNames,
	runFfmpegDiagnostic,
} from "./capabilities/probe.utils";
import { resolveToneMappingMethod, type ToneMapConfig, type ToneMappingMethod } from "./capabilities/tone-mapping.resolver";
import { type HwaccelVerification, verifyHwaccelCandidates } from "./capabilities/verify.service";
import { FFMPEG_QUIET_ARGS } from "./ffmpeg.args";

const logger = createLogger("FfmpegCapabilities");

export interface FfmpegCapabilities {
	version: string;
	filters: ReadonlySet<string>;
	encoders: ReadonlySet<string>;
	hwaccels: ReadonlySet<string>;
	detectedHwaccel: DetectedHwaccel;
	verification: HwaccelVerification | null;
	toneMappingMethod: ToneMappingMethod;
}

let capabilities: FfmpegCapabilities = {
	version: "unavailable",
	filters: new Set(),
	encoders: new Set(),
	hwaccels: new Set(),
	detectedHwaccel: SOFTWARE_HWACCEL,
	verification: null,
	toneMappingMethod: "none",
};

export async function initializeFfmpegCapabilities(): Promise<FfmpegCapabilities> {
	const [versionOutput, filtersOutput, encodersOutput, hwaccelsOutput] = await Promise.all([
		runFfmpegDiagnostic(["-version"]),
		runFfmpegDiagnostic([...FFMPEG_QUIET_ARGS, "-filters"]),
		runFfmpegDiagnostic([...FFMPEG_QUIET_ARGS, "-encoders"]),
		runFfmpegDiagnostic([...FFMPEG_QUIET_ARGS, "-hwaccels"]),
	]);

	if (versionOutput.exitCode !== 0)
		throw new DomainError("internal", `FFmpeg version probe failed: ${versionOutput.stderr}`, { code: "ffmpeg.version_probe_failed" });

	// A build that fails `-filters` or prints an unexpected banner can still
	// transcode — degrade to no filter detection (tone mapping off) the same way
	// encoders/hwaccels do, instead of refusing to boot.
	if (filtersOutput.exitCode !== 0) {
		logger.warn("FFmpeg filters probe failed — continuing without filter detection", { stderr: filtersOutput.stderr.slice(0, 500) });
	}

	const version = parseFfmpegVersion(versionOutput.stdout);
	if (!version) logger.warn("FFmpeg version probe returned an unexpected response — reporting version as unknown");

	const filters = parseFilterNames(filtersOutput.stdout);
	const encoders: ReadonlySet<string> = encodersOutput.exitCode === 0 ? parseEncoderNames(encodersOutput.stdout) : new Set<string>();
	const hwaccels: ReadonlySet<string> = hwaccelsOutput.exitCode === 0 ? parseHwaccelNames(hwaccelsOutput.stdout) : new Set<string>();

	const { detected, verification } = await verifyHwaccelCandidates(getCandidateHwaccels(encoders, hwaccels));

	capabilities = {
		version: version ?? "unknown",
		filters,
		encoders,
		hwaccels,
		detectedHwaccel: detected,
		verification,
		toneMappingMethod: resolveToneMappingMethod(filters),
	};
	logger.info("FFmpeg capabilities initialized", {
		version,
		hwaccelConfigured: serverConfig.ffmpeg.hwaccel,
		hwaccelEffective: detected.type,
		hwaccelDevice: detected.device,
		h264Encoder: detected.h264Encoder,
		hwEncodeVerified: verification?.ok ?? null,
		toneMappingMethod: capabilities.toneMappingMethod,
	});

	return capabilities;
}

export function getFfmpegCapabilities(): FfmpegCapabilities {
	return capabilities;
}

export function getEffectiveHwaccel(): DetectedHwaccel {
	if (serverConfig.ffmpeg.hwaccel !== "auto") {
		return resolveEffectiveHwaccel(capabilities.encoders, capabilities.hwaccels);
	}

	return capabilities.detectedHwaccel;
}

export function missingAudioFilters(): string[] {
	return serverConfig.ffmpeg.requiredAudioFilters.filter((filter) => !capabilities.filters.has(filter));
}

export function getToneMappingMethod(): ToneMappingMethod {
	return capabilities.toneMappingMethod;
}

/**
 * Resolves the tone-mapping method + algorithm once at the streaming boundary,
 * so the arg builders stay pure and share one availability decision.
 */
export function resolveToneMapConfig(): ToneMapConfig {
	return {
		method: serverConfig.ffmpeg.toneMapping === "auto" ? capabilities.toneMappingMethod : "none",
		algorithm: serverConfig.ffmpeg.toneMapAlgorithm,
	};
}

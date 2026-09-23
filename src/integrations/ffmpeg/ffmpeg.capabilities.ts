import { existsSync } from "node:fs";
import type { FfmpegHwaccelOption } from "@/config/definitions/streaming.definitions";
import { spawnAndCollect } from "@/integrations/ffmpeg/ffmpeg.process-runner";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { DirUtils } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

const logger = createLogger("FfmpegCapabilities");
const filterLineRegex = /^\s*[.TSC]+\s+([a-z0-9_]+)\s+/i;
const versionLineRegex = /^ffmpeg version\s+(.+?)(?:\s+Copyright\b|$)/m;
const encoderFlagsRegex = /^[A-Za-z.]{6,9}$/;
const encoderNameRegex = /^[a-z0-9_]+$/;
const whitespaceRegex = /\s+/;

/**
 * Extracts encoder names from `ffmpeg -encoders` output. Entry lines start with a
 * fixed-width flag column (6 chars, 7 in older FFmpeg) like `V....D` — matching
 * flags by letters breaks whenever FFmpeg uses one outside the expected set
 * (nvenc/vaapi/amf carry `D` = direct rendering while qsv does not), so the
 * flags column is matched shape-only and the name is taken as the second token.
 */
export function parseEncoderNames(output: string): ReadonlySet<string> {
	return output.split("\n").reduce<Set<string>>((set, line) => {
		const parts = line.trim().split(whitespaceRegex);
		if (parts.length >= 2 && encoderFlagsRegex.test(parts[0] ?? "") && encoderNameRegex.test(parts[1] ?? "")) {
			const name = parts[1];
			if (name) set.add(name);
		}

		return set;
	}, new Set());
}

type HwaccelType = Exclude<FfmpegHwaccelOption, "auto">;

export interface DetectedHwaccel {
	type: HwaccelType;
	device: string | null;
	h264Encoder: string;
	hevcEncoder: string;
}

/** Result of the test encode proving the selected encoder can actually run. */
export interface HwaccelVerification {
	encoder: string;
	ok: boolean;
	/** Stable failure code (frontend-translated); `null` on success. */
	code: string | null;
	/** Raw FFmpeg stderr tail — developer detail, never translated. */
	detail: string | null;
}

export interface DecodeTestResult {
	ok: boolean;
	code: string | null;
	detail: string | null;
}

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
	detectedHwaccel: {
		type: "none",
		device: null,
		h264Encoder: "libx264",
		hevcEncoder: "libx265",
	},
	verification: null,
	toneMappingMethod: "none",
};

export async function initializeFfmpegCapabilities(): Promise<FfmpegCapabilities> {
	const [versionOutput, filtersOutput, encodersOutput, hwaccelsOutput] = await Promise.all([
		runFfmpeg(["-version"]),
		runFfmpeg(["-hide_banner", "-filters"]),
		runFfmpeg(["-hide_banner", "-encoders"]),
		runFfmpeg(["-hide_banner", "-hwaccels"]),
	]);

	if (versionOutput.exitCode !== 0) throw new Error(`FFmpeg version probe failed: ${versionOutput.stderr}`);

	// A build that fails `-filters` or prints an unexpected banner can still
	// transcode — degrade to no filter detection (tone mapping off) the same way
	// encoders/hwaccels do, instead of refusing to boot.
	if (filtersOutput.exitCode !== 0) {
		logger.warn("FFmpeg filters probe failed — continuing without filter detection", { stderr: filtersOutput.stderr.slice(0, 500) });
	}

	const version = versionOutput.stdout.match(versionLineRegex)?.[1]?.trim();
	if (!version) logger.warn("FFmpeg version probe returned an unexpected response — reporting version as unknown");

	const resolvedVersion = version ?? "unknown";

	const filters = filtersOutput.stdout.split("\n").reduce<Set<string>>((set, line) => {
		const match = line.match(filterLineRegex);
		if (match?.[1]) set.add(match[1]);

		return set;
	}, new Set());

	const encoders: ReadonlySet<string> = encodersOutput.exitCode === 0 ? parseEncoderNames(encodersOutput.stdout) : new Set<string>();

	const hwaccels =
		hwaccelsOutput.exitCode === 0
			? hwaccelsOutput.stdout.split("\n").reduce<Set<string>>((set, raw) => {
					const line = raw.trim();
					if (line && !line.startsWith("Hardware") && !line.startsWith("---")) set.add(line);

					return set;
				}, new Set())
			: new Set<string>();

	const candidates = getCandidateHwaccels(encoders, hwaccels);
	const { detected, verification } = await verifyHwaccelCandidates(candidates);

	capabilities = {
		version: resolvedVersion,
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

export type ToneMappingMethod = "tonemapx" | "zscale" | "none";

/** Resolved tone-mapping inputs for the transcode arg builders. */
export interface ToneMapConfig {
	method: ToneMappingMethod;
	algorithm: string;
}

/**
 * Picks the best available HDR→SDR tone-mapping filter pair for this ffmpeg
 * build: `tonemapx` (jellyfin-ffmpeg, self-contained) or the classic
 * `zscale`+`tonemap` (zimg) combo. `none` = no usable filter, transcode runs
 * without tone-mapping (legacy behavior).
 */
function resolveToneMappingMethod(filters: ReadonlySet<string>): ToneMappingMethod {
	if (filters.has("tonemapx")) return "tonemapx";

	if (filters.has("zscale") && filters.has("tonemap")) return "zscale";

	return "none";
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

/**
 * Input-side hardware decode flags for the accelerator family. Frames land back
 * in system RAM (no `-hwaccel_output_format`), so software filters keep working
 * after the decode.
 */
export function hardwareDecodeArgs(hw: DetectedHwaccel): string[] {
	switch (hw.type) {
		case "nvenc":
			return ["-hwaccel", "cuda", ...(hw.device ? ["-hwaccel_device", hw.device] : [])];
		case "qsv":
			return ["-hwaccel", "qsv", ...(hw.device ? ["-hwaccel_device", hw.device] : [])];
		case "vaapi":
			return ["-hwaccel", "vaapi", ...(hw.device ? ["-vaapi_device", hw.device] : [])];
		case "videotoolbox":
			return ["-hwaccel", "videotoolbox"];
		case "amf":
			return ["-hwaccel", "d3d11va"];
		case "none":
			return [];
		default:
			return [];
	}
}

let cachedDriDevice: string | null | undefined;

function findDriDevice(): string | null {
	if (cachedDriDevice !== undefined) return cachedDriDevice;

	const configuredDevice = serverConfig.ffmpeg.hwaccelDevice.trim();
	if (configuredDevice) {
		cachedDriDevice = configuredDevice;
	} else if (process.platform === "linux") {
		if (existsSync("/dev/dri/renderD128")) cachedDriDevice = "/dev/dri/renderD128";
		else if (existsSync("/dev/dri/card0")) cachedDriDevice = "/dev/dri/card0";
		else cachedDriDevice = null;
	} else {
		cachedDriDevice = null;
	}

	return cachedDriDevice;
}

/** DRM render node used for vaapi/qsv (or the forced hwaccelDevice), null when none was found. */
export function getDetectedDriDevice(): string | null {
	return findDriDevice();
}

function getCandidateHwaccels(encoders: ReadonlySet<string>, hwaccels: ReadonlySet<string>): DetectedHwaccel[] {
	const configHw = serverConfig.ffmpeg.hwaccel;
	const configDevice = serverConfig.ffmpeg.hwaccelDevice.trim() || null;

	const hasEncoder = (name: string) => encoders.size === 0 || encoders.has(name);
	const buildResult = (type: HwaccelType, device: string | null, h264: string, hevc: string): DetectedHwaccel => ({
		type,
		device,
		h264Encoder: hasEncoder(h264) ? h264 : "libx264",
		hevcEncoder: hasEncoder(hevc) ? hevc : "libx265",
	});

	if (configHw === "nvenc") return [buildResult("nvenc", configDevice, "h264_nvenc", "hevc_nvenc")];

	if (configHw === "vaapi") return [buildResult("vaapi", findDriDevice(), "h264_vaapi", "hevc_vaapi")];

	if (configHw === "qsv") return [buildResult("qsv", findDriDevice(), "h264_qsv", "hevc_qsv")];

	if (configHw === "amf") return [buildResult("amf", null, "h264_amf", "hevc_amf")];

	if (configHw === "videotoolbox") return [buildResult("videotoolbox", null, "h264_videotoolbox", "hevc_videotoolbox")];

	if (configHw === "none") return [{ type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" }];

	const driDevice = findDriDevice();
	const candidates: DetectedHwaccel[] = [];

	if (encoders.has("h264_nvenc") && (hwaccels.has("cuda") || hwaccels.has("nvdec") || hwaccels.has("cuvid") || hwaccels.size === 0)) {
		candidates.push(buildResult("nvenc", configDevice, "h264_nvenc", "hevc_nvenc"));
	}

	if (encoders.has("h264_qsv") && (hwaccels.has("qsv") || driDevice !== null) && (driDevice !== null || process.platform !== "linux")) {
		candidates.push(buildResult("qsv", driDevice, "h264_qsv", "hevc_qsv"));
	}

	if (encoders.has("h264_vaapi") && (hwaccels.has("vaapi") || driDevice !== null) && (driDevice !== null || process.platform !== "linux")) {
		candidates.push(buildResult("vaapi", driDevice, "h264_vaapi", "hevc_vaapi"));
	}

	if (encoders.has("h264_amf") && (hwaccels.has("amf") || hwaccels.has("d3d11va") || hwaccels.size === 0)) {
		candidates.push(buildResult("amf", null, "h264_amf", "hevc_amf"));
	}

	if (process.platform === "darwin" && encoders.has("h264_videotoolbox")) {
		candidates.push(buildResult("videotoolbox", null, "h264_videotoolbox", "hevc_videotoolbox"));
	}

	return candidates;
}

function resolveEffectiveHwaccel(encoders: ReadonlySet<string>, hwaccels: ReadonlySet<string>): DetectedHwaccel {
	const candidates = getCandidateHwaccels(encoders, hwaccels);

	return candidates[0] ?? { type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" };
}

async function runFfmpeg(args: string[], timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const { exitCode, stdout, stderr } = await spawnAndCollect({
		cmd: [serverConfig.ffmpeg.path, ...args],
		timeoutMs,
		purpose: "diagnostic",
	});

	return { exitCode, stdout, stderr };
}

// A 2-frame test encode on a slow single core flirts with a fixed 15 s
// budget — scale with measured CPU speed so GPU-less weak boxes don't get
// false "no hwaccel" results.
const TEST_ENCODE_TIMEOUT_MS = () => systemResourcesService.scaledTimeoutMs(15_000);
const TEST_DECODE_TIMEOUT_MS = () => systemResourcesService.scaledTimeoutMs(15_000);

/**
 * Proves that a hardware encoder can actually initialize and encode frames.
 * When multiple accelerators are candidate in "auto" mode, test-encodes run in
 * parallel and the winner is chosen by the original preference order — on a
 * GPU-less host each failed candidate would otherwise burn its 15 s timeout
 * sequentially at boot (up to a minute before the port binds).
 */
async function verifyHwaccelCandidates(
	candidates: DetectedHwaccel[],
): Promise<{ detected: DetectedHwaccel; verification: HwaccelVerification | null }> {
	if (candidates.length === 0) {
		return {
			detected: { type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" },
			verification: null,
		};
	}

	const immediateNone = candidates.find((candidate) => candidate.type === "none");
	if (immediateNone) {
		return { detected: immediateNone, verification: null };
	}

	const results = await PromiseUtils.mapConcurrent(
		candidates,
		systemResourcesService.getHeavySubprocessConcurrency(),
		async (candidate) => {
			const result = await runTestEncode(candidate);

			return {
				candidate,
				verification: {
					encoder: candidate.h264Encoder,
					ok: result.ok,
					code: result.code,
					detail: result.detail,
				} satisfies HwaccelVerification,
			};
		},
	);

	const explicitHwaccel = serverConfig.ffmpeg.hwaccel !== "auto";
	let firstFailure: HwaccelVerification | null = null;
	for (const { candidate, verification } of results) {
		if (verification.ok) {
			logger.info("HW encoder candidate verified successfully", {
				type: candidate.type,
				encoder: candidate.h264Encoder,
				device: candidate.device,
			});

			return { detected: candidate, verification };
		}

		firstFailure ??= verification;
		const failure = {
			type: candidate.type,
			encoder: candidate.h264Encoder,
			detail: verification.detail,
		};
		// In "auto" mode every encoder the FFmpeg build advertises is probed, and
		// a host without the matching GPU/driver fails most of them. That is the
		// expected path to software encoding — not a problem worth warning about.
		// Only an explicitly configured accelerator that fails is actionable.
		if (explicitHwaccel) {
			logger.warn("Configured HW candidate failed test encode", failure);
		} else {
			logger.debug("HW candidate failed test encode", failure);
		}
	}

	const attempted = candidates.map((candidate) => candidate.h264Encoder);
	if (explicitHwaccel) {
		logger.warn(`Configured HW encoder '${serverConfig.ffmpeg.hwaccel}' failed — falling back to software`, {
			attempted,
			detail: firstFailure?.detail,
		});
	} else {
		logger.info("No usable HW encoder detected — using software encoding", { attempted });
	}

	return {
		detected: { type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" },
		verification: firstFailure,
	};
}

const HW_DEVICE_FLAGS: Partial<Record<string, string>> = {
	vaapi: "-vaapi_device",
	qsv: "-qsv_device",
	nvenc: "-gpu",
};

function buildTestEncodeArgs(hw: DetectedHwaccel): string[] {
	const common = ["-hide_banner", "-loglevel", "error"];
	const deviceFlag = HW_DEVICE_FLAGS[hw.type];
	const lavfiInput = ["-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.2:r=10"];
	const deviceArgs = deviceFlag && hw.device ? [deviceFlag, hw.device] : [];
	const vfArgs = hw.type === "vaapi" ? ["-vf", "format=nv12,hwupload"] : [];

	return [...common, ...deviceArgs, ...lavfiInput, ...vfArgs, "-frames:v", "2", "-c:v", hw.h264Encoder, "-f", "null", "-"];
}

async function runTestEncode(hw: DetectedHwaccel): Promise<{ ok: boolean; code: string | null; detail: string | null }> {
	const args = buildTestEncodeArgs(hw);
	const { exitCode, stderr } = await runFfmpeg(args, TEST_ENCODE_TIMEOUT_MS());
	if (exitCode === 0) return { ok: true, code: null, detail: null };

	return { ok: false, code: "ffmpeg.hwaccel.verify_failed", detail: stderr.trim() || `FFmpeg exited with code ${exitCode}` };
}

/**
 * Proves the accelerator can hardware-decode, not just encode — frame extraction
 * (trickplay, thumbnails) leans on the decoder while streaming leans on the encoder.
 * Generates a tiny H.264 elementary stream in the transcodes tmp dir, then decodes
 * it with the accelerator's input args. Not run at startup — on demand only.
 */
export async function runHwaccelDecodeTest(hw: DetectedHwaccel): Promise<DecodeTestResult> {
	if (hw.type === "none") return { ok: false, code: "ffmpeg.hwaccel.none_effective", detail: null };

	const tmpDir = PathUtils.join(serverConfig.paths.transcodes, ".tmp");
	const probePath = PathUtils.join(tmpDir, `hwaccel_decode_probe_${crypto.randomUUID()}.bin`);
	await DirUtils.create(tmpDir);

	try {
		// Raw H.264 elementary stream with a .bin suffix — no temp file may look like
		// a media file, cleanup helpers refuse to delete those.
		const generate = await runFfmpeg(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=s=256x144:d=0.5:r=10",
				"-frames:v",
				"5",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				"-f",
				"h264",
				"-y",
				probePath,
			],
			TEST_DECODE_TIMEOUT_MS(),
		);
		if (generate.exitCode !== 0) {
			return {
				ok: false,
				code: "ffmpeg.decode_test.generate_failed",
				detail: generate.stderr.trim() || `exit code ${generate.exitCode}`,
			};
		}

		const decode = await runFfmpeg(
			["-hide_banner", "-loglevel", "error", ...hardwareDecodeArgs(hw), "-i", probePath, "-frames:v", "2", "-f", "null", "-"],
			TEST_DECODE_TIMEOUT_MS(),
		);
		if (decode.exitCode === 0) return { ok: true, code: null, detail: null };

		return { ok: false, code: "ffmpeg.decode_test.decode_failed", detail: decode.stderr.trim() || `exit code ${decode.exitCode}` };
	} finally {
		await FileUtils.delete(probePath);
	}
}

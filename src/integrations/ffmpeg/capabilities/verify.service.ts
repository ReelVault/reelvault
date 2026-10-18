import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { DirUtils } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { type DetectedHwaccel, hardwareDecodeArgs, SOFTWARE_HWACCEL, withDevice } from "./hwaccel.utils";
import { runFfmpegDiagnostic } from "./probe.utils";

const logger = createLogger("FfmpegCapabilities");

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

const QUIET_FFMPEG_ARGS = ["-hide_banner", "-loglevel", "error"];

// A 2-frame test encode on a slow single core flirts with a fixed 15 s
// budget — scale with measured CPU speed so GPU-less weak boxes don't get
// false "no hwaccel" results.
function testTimeoutMs() {
	return systemResourcesService.scaledTimeoutMs(15_000);
}

/**
 * Proves that a hardware encoder can actually initialize and encode frames.
 * When multiple accelerators are candidate in "auto" mode, test-encodes run in
 * parallel and the winner is chosen by the original preference order — on a
 * GPU-less host each failed candidate would otherwise burn its 15 s timeout
 * sequentially at boot (up to a minute before the port binds).
 */
export async function verifyHwaccelCandidates(
	candidates: DetectedHwaccel[],
): Promise<{ detected: DetectedHwaccel; verification: HwaccelVerification | null }> {
	if (candidates.length === 0) {
		return {
			detected: SOFTWARE_HWACCEL,
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
		detected: SOFTWARE_HWACCEL,
		verification: firstFailure,
	};
}

const HW_DEVICE_FLAGS: Partial<Record<string, string>> = {
	vaapi: "-vaapi_device",
	qsv: "-qsv_device",
	nvenc: "-gpu",
};

function buildTestEncodeArgs(hw: DetectedHwaccel): string[] {
	const deviceFlag = HW_DEVICE_FLAGS[hw.type];
	const lavfiInput = ["-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.2:r=10"];
	const deviceArgs = deviceFlag ? withDevice(deviceFlag, hw.device) : [];
	const vfArgs = hw.type === "vaapi" ? ["-vf", "format=nv12,hwupload"] : [];

	return [...QUIET_FFMPEG_ARGS, ...deviceArgs, ...lavfiInput, ...vfArgs, "-frames:v", "2", "-c:v", hw.h264Encoder, "-f", "null", "-"];
}

async function runTestEncode(hw: DetectedHwaccel): Promise<DecodeTestResult> {
	const { exitCode, stderr } = await runFfmpegDiagnostic(buildTestEncodeArgs(hw), testTimeoutMs());
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
		const generate = await runFfmpegDiagnostic(
			[
				...QUIET_FFMPEG_ARGS,
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
			testTimeoutMs(),
		);
		if (generate.exitCode !== 0) {
			return {
				ok: false,
				code: "ffmpeg.decode_test.generate_failed",
				detail: generate.stderr.trim() || `exit code ${generate.exitCode}`,
			};
		}

		const decode = await runFfmpegDiagnostic(
			[...QUIET_FFMPEG_ARGS, ...hardwareDecodeArgs(hw), "-i", probePath, "-frames:v", "2", "-f", "null", "-"],
			testTimeoutMs(),
		);
		if (decode.exitCode === 0) return { ok: true, code: null, detail: null };

		return { ok: false, code: "ffmpeg.decode_test.decode_failed", detail: decode.stderr.trim() || `exit code ${decode.exitCode}` };
	} finally {
		await FileUtils.delete(probePath);
	}
}

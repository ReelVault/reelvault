import { describe, expect, it } from "bun:test";
import { getEffectiveHwaccel, getFfmpegCapabilities, initializeFfmpegCapabilities, parseEncoderNames } from "./ffmpeg.capabilities";
import { ffMpegService } from "./ffmpeg.service";

const ENCODER_NAME_REGEX = /^[a-z0-9_]+$/;

// Shaped after jellyfin-ffmpeg 7.1 output: nvenc/vaapi/amf carry the `D` flag
// (direct rendering) while qsv does not — the old letter-based regex silently
// dropped every `D` line, leaving only qsv encoders "detected".
const JELLYFIN_ENCODERS_OUTPUT = [
	"Encoders:",
	" V..... = Video",
	" A..... = Audio",
	" S..... = Subtitle",
	" .F.... = Frame-level multithreading",
	" ..S... = Slice-level multithreading",
	" ...X.. = Codec is experimental",
	" ....B. = Supports draw_horiz_band",
	" .....D = Supports direct rendering method 1",
	" ------",
	" V.....D aac    AAC (Advanced Audio Coding) (codec aac)",
	" V.....D h264_nvenc    NVIDIA NVENC H.264 encoder (codec h264)",
	" V..... h264_qsv    Quick Sync Video H.264 encoder (codec h264)",
	" V.....D h264_vaapi    VA-API H.264 encoder (codec h264)",
	" V.....D hevc_amf    AMD AMF HEVC encoder (codec hevc)",
	" V....XZ hevc_vaapi    VA-API HEVC encoder (codec hevc)",
	" V...... libx264    libx264 H.264 (codec h264)",
].join("\n");

describe("FFmpeg Capabilities & HW Transcoding Abstraction", () => {
	it("parses encoder names from -encoders output including D-flagged lines", () => {
		const encoders = parseEncoderNames(JELLYFIN_ENCODERS_OUTPUT);
		expect(encoders.has("h264_nvenc")).toBe(true);
		expect(encoders.has("h264_vaapi")).toBe(true);
		expect(encoders.has("hevc_vaapi")).toBe(true);
		expect(encoders.has("hevc_amf")).toBe(true);
		expect(encoders.has("h264_qsv")).toBe(true);
		expect(encoders.has("aac")).toBe(true);
		expect(encoders.has("libx264")).toBe(true);
	});

	it("rejects headers, legend lines, and separators", () => {
		const encoders = parseEncoderNames(JELLYFIN_ENCODERS_OUTPUT);
		expect(encoders.has("Encoders")).toBe(false);
		expect(encoders.has("Video")).toBe(false);
		expect(encoders.has("Audio")).toBe(false);
		expect([...encoders].every((name) => ENCODER_NAME_REGEX.test(name))).toBe(true);
	});

	it("returns an empty set for empty output", () => {
		expect(parseEncoderNames("").size).toBe(0);
	});

	// The remaining tests probe the real binary — skipped where it is absent.
	const hasFfmpeg = ffMpegService.isAvailable();

	it.skipIf(!hasFfmpeg)("initializes capabilities and detects filters and encoders", async () => {
		const caps = await initializeFfmpegCapabilities();
		expect(caps.version).toBeDefined();
		expect(caps.version).not.toBe("unavailable");
		expect(caps.version).not.toContain("Copyright");
		expect(caps.filters.size).toBeGreaterThan(0);
		expect(caps.encoders.size).toBeGreaterThan(0);

		const hw = getEffectiveHwaccel();
		expect(hw).toBeDefined();
		expect(["none", "nvenc", "vaapi", "qsv", "videotoolbox"]).toContain(hw.type);
		expect(hw.h264Encoder).toBeDefined();
	});

	it.skipIf(!hasFfmpeg)("returns cached capabilities via getFfmpegCapabilities", () => {
		const caps = getFfmpegCapabilities();
		expect(caps.version).not.toBe("unavailable");
	});
});

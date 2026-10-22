import { describe, expect, it } from "bun:test";
import { parseEncoderNames } from "./capabilities/probe.utils";
import { getFfmpegCapabilities, initializeFfmpegCapabilities } from "./ffmpeg.capabilities";

const ENCODER_NAME_REGEX = /^[a-z0-9_]+$/;
// The version segment of the ffmpeg banner: a release ("7.1") or a nightly ("n9.0.2") build.
const VERSION_PATTERN = /\d+\.\d+/;

// Shaped after ffmpeg 7.1 output: nvenc/vaapi/amf carry the `D` flag
// (direct rendering) while qsv does not — the old letter-based regex silently
// dropped every `D` line, leaving only qsv encoders "detected".
const ENCODERS_OUTPUT = [
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
		const encoders = parseEncoderNames(ENCODERS_OUTPUT);
		expect(encoders.has("h264_nvenc")).toBe(true);
		expect(encoders.has("h264_vaapi")).toBe(true);
		expect(encoders.has("hevc_vaapi")).toBe(true);
		expect(encoders.has("hevc_amf")).toBe(true);
		expect(encoders.has("h264_qsv")).toBe(true);
		expect(encoders.has("aac")).toBe(true);
		expect(encoders.has("libx264")).toBe(true);
	});

	it("rejects headers, legend lines, and separators", () => {
		const encoders = parseEncoderNames(ENCODERS_OUTPUT);
		expect(encoders.has("Encoders")).toBe(false);
		expect(encoders.has("Video")).toBe(false);
		expect(encoders.has("Audio")).toBe(false);
		expect([...encoders].every((name) => ENCODER_NAME_REGEX.test(name))).toBe(true);
	});

	it("returns an empty set for empty output", () => {
		expect(parseEncoderNames("").size).toBe(0);
	});

	it("detects the installed ffmpeg's version, filters and encoders", async () => {
		const caps = await initializeFfmpegCapabilities();

		// The banner of a release ("7.1") or a nightly ("n9.0.2") build: a numeric release, never the fallback sentinels.
		expect(caps.version).toMatch(VERSION_PATTERN);
		expect(caps.version.includes("Copyright")).toBe(false);
		expect(caps.filters.has("scale")).toBe(true);
		expect(caps.encoders.has("aac")).toBe(true);
	});

	it("serves the initialized capabilities from the cache", async () => {
		await initializeFfmpegCapabilities();

		const cached = getFfmpegCapabilities();

		expect(cached.version).toMatch(VERSION_PATTERN);
		expect(cached.filters.has("scale")).toBe(true);
		expect(cached.encoders.has("aac")).toBe(true);
	});
});

import { afterAll, describe, expect, it } from "bun:test";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../tests/helpers/module-mock.helper";
import { parseEncoderNames } from "./capabilities/probe.utils";
import { getFfmpegCapabilities, initializeFfmpegCapabilities } from "./ffmpeg.capabilities";

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
const ENCODER_NAMES = ["aac", "h264_nvenc", "h264_qsv", "h264_vaapi", "hevc_amf", "hevc_vaapi", "libx264"];

const VERSION_OUTPUT = ["ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers", "built with gcc 14.2.1"].join("\n");
const FILTERS_OUTPUT = [
	"Filters:",
	"  T.. = Timeline support",
	"  .S. = Slice threading",
	"  ..C = Command support",
	" ... anullsink      A->N       Do absolutely nothing with the input audio.",
	" ... scale          V->V       Scale the input video size and/or convert the image format.",
	" ... tonemap        V->V       Conversion of tone mapping.",
	" ... zscale         V->V       Apply resizing, colorspace and bit depth conversion.",
].join("\n");
const HWACCELS_OUTPUT = ["Hardware acceleration methods:", "cuda", "vaapi"].join("\n");

// The four probes that initializeFfmpegCapabilities runs, keyed by the flag each one ends with.
const PROBE_OUTPUTS: Record<string, string> = {
	"-version": VERSION_OUTPUT,
	"-filters": FILTERS_OUTPUT,
	"-encoders": ENCODERS_OUTPUT,
	"-hwaccels": HWACCELS_OUTPUT,
};

// The detected sets depend on the host's ffmpeg build and on the DRM render node,
// so the probe runner and the device lookup are replaced with fixed output.
mockModuleWithRealExports("@/integrations/ffmpeg/capabilities/probe.utils", {
	runFfmpegDiagnostic: (args: string[]) => {
		const stdout = PROBE_OUTPUTS[args.at(-1) ?? ""];
		if (stdout === undefined) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "no fixture for this probe", timedOut: false });

		return Promise.resolve({ exitCode: 0, stdout, stderr: "", timedOut: false });
	},
	getDetectedDriDevice: () => null,
});

afterAll(() => {
	restoreModuleMocks();
});

describe("FFmpeg Capabilities & HW Transcoding Abstraction", () => {
	it("keeps every encoder line, D-flagged or not, and skips the header, legend and separator", () => {
		expect(parseEncoderNames(ENCODERS_OUTPUT)).toEqual(new Set(ENCODER_NAMES));
	});

	it("returns an empty set for empty output", () => {
		expect(parseEncoderNames("").size).toBe(0);
	});

	it("reads the version, filters, encoders and accelerators from the probe output", async () => {
		const caps = await initializeFfmpegCapabilities();

		expect(caps.version).toBe("7.1");
		expect(caps.filters).toEqual(new Set(["anullsink", "scale", "tonemap", "zscale"]));
		expect(caps.encoders).toEqual(new Set(ENCODER_NAMES));
		expect(caps.hwaccels).toEqual(new Set(["cuda", "vaapi"]));
	});

	it("serves the initialized capabilities from the cache", async () => {
		const initialized = await initializeFfmpegCapabilities();

		expect(getFfmpegCapabilities()).toBe(initialized);
	});
});

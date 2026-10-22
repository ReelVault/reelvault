import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";
import { type DetectedHwaccel, getCandidateHwaccels, hardwareDecodeArgs, resolveEffectiveHwaccel, withDevice } from "./hwaccel.utils";

// A DRM render node is a property of the machine, not of the ffmpeg build. The
// vaapi and qsv candidates need one on Linux, so the probe is replaced —
// otherwise the candidate list depends on whether the runner has /dev/dri, and
// the test passes on a desktop and fails on a container.
const DRI_DEVICE = "/dev/dri/renderD128";

mockModuleWithRealExports("@/integrations/ffmpeg/capabilities/probe.utils", {
	getDetectedDriDevice: () => DRI_DEVICE,
});

// The encoder and accelerator sets are literals, so the expectations hold on
// every ffmpeg build: a machine with NVENC, a CI runner with a plain apt
// build and a jellyfin-ffmpeg build all take the same decisions.
const NVENC_ENCODERS = new Set(["libx264", "libx265", "h264_nvenc", "hevc_nvenc", "aac"]);
const VAAPI_ENCODERS = new Set(["libx264", "libx265", "h264_vaapi", "hevc_vaapi", "aac"]);
const QSV_ENCODERS = new Set(["libx264", "libx265", "h264_qsv", "hevc_qsv", "aac"]);
const AMF_ENCODERS = new Set(["libx264", "libx265", "h264_amf", "hevc_amf", "aac"]);
const SOFTWARE_ENCODERS = new Set(["libx264", "libx265", "aac"]);
const SOFTWARE: DetectedHwaccel = { type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" };

beforeEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

afterAll(() => {
	restoreModuleMocks();
});

describe("getCandidateHwaccels", () => {
	it("returns the software encoder when the configuration says so", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "none");

		expect(getCandidateHwaccels(NVENC_ENCODERS, new Set(["cuda"]))).toEqual([SOFTWARE]);
	});

	it("honours the configured accelerator over the advertised ones", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "vaapi");

		const candidates = getCandidateHwaccels(new Set([...NVENC_ENCODERS, ...VAAPI_ENCODERS]), new Set(["cuda", "vaapi"]));

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.type).toBe("vaapi");
		expect(candidates[0]?.h264Encoder).toBe("h264_vaapi");
		expect(candidates[0]?.hevcEncoder).toBe("hevc_vaapi");
	});

	it("takes the device from the configuration", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "nvenc");
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccelDevice", "/dev/nvidia0");

		expect(getCandidateHwaccels(NVENC_ENCODERS, new Set(["cuda"]))[0]?.device).toBe("/dev/nvidia0");
	});

	// The DRM render node is what the vaapi and qsv candidates decode through.
	it("takes the DRM device of the host for the vaapi and qsv candidates", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "vaapi");

		expect(getCandidateHwaccels(VAAPI_ENCODERS, new Set(["vaapi"]))[0]?.device).toBe(DRI_DEVICE);
	});

	it("picks the first advertised accelerator in auto mode", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "auto");

		const candidates = getCandidateHwaccels(new Set([...NVENC_ENCODERS, ...VAAPI_ENCODERS, ...QSV_ENCODERS]), new Set(["cuda", "vaapi"]));

		expect(candidates[0]?.type).toBe("nvenc");
	});

	// The build does not advertise the preferred accelerator, so the next one it
	// does advertise is used.
	it("falls back to the next advertised accelerator when the first is missing from the build", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "auto");

		const candidates = getCandidateHwaccels(AMF_ENCODERS, new Set(["d3d11va"]));

		expect(candidates[0]?.type).toBe("amf");
		expect(candidates[0]?.h264Encoder).toBe("h264_amf");
	});

	// A build that advertises the encoder but cannot run it is caught by the
	// test encode; the candidate still carries the hardware encoder name.
	it("keeps the hardware encoder name when the build advertises it", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "nvenc");

		const candidate = getCandidateHwaccels(NVENC_ENCODERS, new Set(["cuda"]))[0];

		expect(candidate?.h264Encoder).toBe("h264_nvenc");
		expect(candidate?.hevcEncoder).toBe("hevc_nvenc");
	});

	// A build without the hardware encoder must not be asked to use it.
	it("falls back to software encoding when the build has no hardware encoder", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "nvenc");

		const candidate = getCandidateHwaccels(SOFTWARE_ENCODERS, new Set(["cuda"]))[0];

		expect(candidate?.type).toBe("nvenc");
		expect(candidate?.h264Encoder).toBe("libx264");
		expect(candidate?.hevcEncoder).toBe("libx265");
	});

	// A probe that never ran leaves the encoder set empty; the configuration then
	// is the only source of truth.
	it("keeps the configured encoder when the probe reported nothing", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "nvenc");

		const candidate = getCandidateHwaccels(new Set(), new Set())[0];

		expect(candidate?.h264Encoder).toBe("h264_nvenc");
		expect(candidate?.hevcEncoder).toBe("hevc_nvenc");
	});
});

describe("resolveEffectiveHwaccel", () => {
	it("returns the software encoder when the build advertises no accelerator", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "auto");

		expect(resolveEffectiveHwaccel(SOFTWARE_ENCODERS, new Set())).toEqual(SOFTWARE);
	});

	it("returns the configured accelerator when the configuration pins one", () => {
		systemSettingsStore.setRuntimeValue("ffmpeg.hwaccel", "qsv");

		expect(resolveEffectiveHwaccel(SOFTWARE_ENCODERS, new Set()).type).toBe("qsv");
	});
});

describe("hardwareDecodeArgs", () => {
	it.each([
		["nvenc", ["-hwaccel", "cuda"]],
		["qsv", ["-hwaccel", "qsv"]],
		["vaapi", ["-hwaccel", "vaapi"]],
		["videotoolbox", ["-hwaccel", "videotoolbox"]],
		["amf", ["-hwaccel", "d3d11va"]],
		["none", []],
	] as const)("maps the %s accelerator to its decode arguments", (type, expected) => {
		const hw: DetectedHwaccel = { type, device: null, h264Encoder: "h264", hevcEncoder: "hevc" };

		expect(hardwareDecodeArgs(hw)).toEqual([...expected]);
	});

	it("adds the device flag when the accelerator has one", () => {
		expect(hardwareDecodeArgs({ type: "nvenc", device: "/dev/dri/renderD128", h264Encoder: "h264", hevcEncoder: "hevc" })).toEqual([
			"-hwaccel",
			"cuda",
			"-hwaccel_device",
			"/dev/dri/renderD128",
		]);
	});
});

describe("withDevice", () => {
	it("adds the device when there is one", () => {
		expect(withDevice("-vaapi_device", "/dev/dri/renderD128")).toEqual(["-vaapi_device", "/dev/dri/renderD128"]);
	});

	it("adds nothing when there is no device", () => {
		expect(withDevice("-vaapi_device", null)).toEqual([]);
	});
});

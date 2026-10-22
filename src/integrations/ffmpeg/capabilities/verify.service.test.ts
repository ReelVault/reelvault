import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { systemSettingsStore } from "@/config/system-settings.store";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";
import { type DetectedHwaccel, SOFTWARE_HWACCEL } from "./hwaccel.utils";
import { verifyHwaccelCandidates } from "./verify.service";

// The test encode is the one place where the host's ffmpeg build decides the
// outcome: a build without NVENC fails the encode even on a machine that has
// the GPU. The probe is therefore replaced, so the expectations hold on every
// build and every machine.
const probeCalls: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
let probeExitCode = 0;

mockModuleWithRealExports("@/integrations/ffmpeg/capabilities/probe.utils", {
	runFfmpegDiagnostic: (args: string[], timeoutMs?: number) => {
		probeCalls.push({ args, timeoutMs });
		return Promise.resolve({ exitCode: probeExitCode, stdout: new Uint8Array(), stderr: probeExitCode === 0 ? "" : "no such device" });
	},
});

const NVENC: DetectedHwaccel = { type: "nvenc", device: null, h264Encoder: "h264_nvenc", hevcEncoder: "hevc_nvenc" };
const VAAPI: DetectedHwaccel = { type: "vaapi", device: null, h264Encoder: "h264_vaapi", hevcEncoder: "hevc_vaapi" };

beforeEach(() => {
	probeCalls.length = 0;
	probeExitCode = 0;
	systemSettingsStore.clearRuntimeValues();
});

afterEach(() => {
	systemSettingsStore.clearRuntimeValues();
});

afterAll(() => {
	restoreModuleMocks();
});

describe("verifyHwaccelCandidates", () => {
	it("returns the software encoder when there is no candidate", async () => {
		const result = await verifyHwaccelCandidates([]);

		expect(result.detected).toEqual(SOFTWARE_HWACCEL);
		expect(result.verification).toBeNull();
		expect(probeCalls).toHaveLength(0);
	});

	it("accepts the software candidate without running a test encode", async () => {
		const result = await verifyHwaccelCandidates([SOFTWARE_HWACCEL]);

		expect(result.detected).toEqual(SOFTWARE_HWACCEL);
		expect(result.verification).toBeNull();
		expect(probeCalls).toHaveLength(0);
	});

	it("keeps the candidate whose test encode succeeded", async () => {
		const result = await verifyHwaccelCandidates([NVENC]);

		expect(result.detected.type).toBe("nvenc");
		expect(result.detected.h264Encoder).toBe("h264_nvenc");
		expect(result.verification).toEqual({ encoder: "h264_nvenc", ok: true, code: null, detail: null });
	});

	it("falls back to software when every candidate fails the test encode", async () => {
		probeExitCode = 1;

		const result = await verifyHwaccelCandidates([NVENC]);

		expect(result.detected).toEqual(SOFTWARE_HWACCEL);
		expect(result.verification?.ok).toBe(false);
		expect(result.verification?.code).toBe("ffmpeg.hwaccel.verify_failed");
		expect(result.verification?.detail).toBe("no such device");
	});

	it("picks the first candidate in the preference order, not the first that answers", async () => {
		probeExitCode = 1;
		const result = await verifyHwaccelCandidates([NVENC, VAAPI]);

		expect(result.detected).toEqual(SOFTWARE_HWACCEL);
		expect(result.verification?.encoder).toBe("h264_nvenc");
	});

	// The probe runs before the port binds, so a driver that hangs must not keep
	// the server from starting.
	it("gives the hardware test encode a short fixed budget", async () => {
		await verifyHwaccelCandidates([NVENC]);

		expect(probeCalls[0]?.timeoutMs).toBe(5_000);
	});

	it("encodes with the candidate's own encoder and the device flag it needs", async () => {
		await verifyHwaccelCandidates([VAAPI]);

		const args = probeCalls[0]?.args ?? [];
		expect(args).toContain("h264_vaapi");
		expect(args).toContain("-frames:v");
		expect(args[args.indexOf("-frames:v") + 1]).toBe("2");
	});
});

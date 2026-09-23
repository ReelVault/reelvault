import type { AdminFfmpegCapabilities, FfmpegDecodeTest } from "@reelvault/sdk/common";
import {
	getDetectedDriDevice,
	getEffectiveHwaccel,
	getFfmpegCapabilities,
	getToneMappingMethod,
	initializeFfmpegCapabilities,
	runHwaccelDecodeTest,
} from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";

const HARDWARE_ENCODER_PATTERN = /_(nvenc|vaapi|qsv|amf|videotoolbox)$/;

/**
 * Read-only view over the FFmpeg capability probe for the admin panel: what the
 * binary supports, which accelerator the server actually uses, and whether the
 * startup test encode passed (with the error that made it fall back to software).
 */
class AdminFfmpegCapabilitiesService extends BaseService {
	private lastDecodeTest: FfmpegDecodeTest | null = null;

	constructor() {
		super("AdminFfmpegCapabilitiesService");
	}

	getCapabilities(): AdminFfmpegCapabilities {
		return this.buildView();
	}

	/** Re-runs the full probe (encoders/hwaccels/test encode) and additionally runs a one-off decode test. */
	async refreshCapabilities(): Promise<AdminFfmpegCapabilities> {
		await initializeFfmpegCapabilities();

		const effective = getEffectiveHwaccel();
		const decodeTest = await runHwaccelDecodeTest(effective);
		this.lastDecodeTest = { accelerator: effective.type, ok: decodeTest.ok, code: decodeTest.code, detail: decodeTest.detail };
		if (!decodeTest.ok && effective.type !== "none") {
			this.logger.warn("HW decode test failed", { accelerator: effective.type, code: decodeTest.code, detail: decodeTest.detail });
		}

		return this.buildView();
	}

	private buildView(): AdminFfmpegCapabilities {
		const capabilities = getFfmpegCapabilities();

		return {
			version: capabilities.version,
			binaryPath: serverConfig.ffmpeg.path,
			configured: serverConfig.ffmpeg.hwaccel,
			effective: { ...getEffectiveHwaccel() },
			verification: capabilities.verification ? { ...capabilities.verification } : null,
			decodeTest: this.lastDecodeTest,
			hwaccelApis: [...capabilities.hwaccels].toSorted(),
			hardwareEncoders: [...capabilities.encoders].filter((encoder) => HARDWARE_ENCODER_PATTERN.test(encoder)).toSorted(),
			driDevice: getDetectedDriDevice(),
			toneMappingMethod: getToneMappingMethod(),
			toneMapping: serverConfig.ffmpeg.toneMapping,
			toneMapAlgorithm: serverConfig.ffmpeg.toneMapAlgorithm,
		};
	}
}

export const adminFfmpegCapabilitiesService = new AdminFfmpegCapabilitiesService();

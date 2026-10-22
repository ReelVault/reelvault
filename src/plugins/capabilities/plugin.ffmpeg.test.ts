import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { serverConfig } from "@/config/server/server.config";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { deleteFile as actualDeleteFile, fileExists as actualFileExists } from "@/utils/file.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../tests/helpers/module-mock.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginFfmpegService } from "./plugin.ffmpeg";

// The mock replaces the module, so the real implementation is captured before
// it lands: a mock that called back into the module it replaces would recurse.
const realDeleteFile = actualDeleteFile;
const realFileExists = actualFileExists;

let fileExistsImpl: (path: string) => Promise<boolean> = realFileExists;
mockModuleWithRealExports("@/utils/file.utils", {
	deleteFile: realDeleteFile,
	fileExists: (path: string) => fileExistsImpl(path),
});

const db = useTestDatabase();
const activeStubs: Array<{ restore(): void }> = [];
const OUTPUT_FILE_RE = /\.(webp|jpe?g)$/;
const FAKE_FRAME_BYTES = [0x01, 0x02, 0x03];
let mediaFileId = "";

/** The service only stats/reads ffmpeg's output files, never decodes them —
 * the stub fakes a successful encode by writing bytes to every output path. */
function contentBytes(content: Blob | Uint8Array): number {
	return content instanceof Uint8Array ? content.byteLength : content.size;
}

function stubRunToCompletion(exitCode: number) {
	activeStubs.push(
		stubMethod(ffMpegService, "runToCompletion", (args: string[]) => {
			for (const arg of args) {
				if (OUTPUT_FILE_RE.test(arg)) writeFileSync(arg, Buffer.from(FAKE_FRAME_BYTES));
			}

			return Promise.resolve({ exitCode, stdout: new Uint8Array(), stderr: exitCode === 0 ? "" : "mock failure" });
		}),
	);
}

beforeEach(async () => {
	activeStubs.length = 0;
	mediaFileId = await insertMovieMediaFile(db.client(), "/media/movie.mkv", "meta-1");
	fileExistsImpl = () => Promise.resolve(true);
});

afterEach(() => {
	fileExistsImpl = realFileExists;
	for (const stub of activeStubs.toReversed()) stub.restore();
});

// The next test file must get the real module back.
afterAll(() => {
	restoreModuleMocks();
});

describe("pluginFfmpegService.extractFrame", () => {
	test("rejects an unknown media file", async () => {
		await expect(pluginFfmpegService.extractFrame({ mediaFileId: "missing", timeMs: 1_000, width: 320 })).rejects.toMatchObject({
			code: "plugin.ffmpeg.media_not_found",
		});
	});

	test("returns the encoded webp bytes for a successful extraction", async () => {
		stubRunToCompletion(0);

		const frame = await pluginFfmpegService.extractFrame({ mediaFileId, timeMs: 1_000, width: 320 });

		expect(frame.contentType).toBe("image/webp");
		expect(contentBytes(frame.content)).toBe(FAKE_FRAME_BYTES.length);
	});

	test("cleans the temp output and reports process failures", async () => {
		stubRunToCompletion(1);
		const tempDir = serverConfig.paths.transcodeTmp;

		await expect(pluginFfmpegService.extractFrame({ mediaFileId, timeMs: 1_000, width: 320 })).rejects.toMatchObject({
			code: "plugin.ffmpeg.process_failed",
		});

		const leftovers = existsSync(tempDir) ? readdirSync(tempDir).filter((name) => name.startsWith("frame_")) : [];
		expect(leftovers).toEqual([]);
	});
});

describe("pluginFfmpegService.extractSprite", () => {
	test("assembles a sprite sheet from per-frame extractions", async () => {
		stubRunToCompletion(0);

		const sprite = await pluginFfmpegService.extractSprite({
			mediaFileId,
			timeMs: [1_000, 2_000],
			width: 256,
			height: 144,
			columns: 2,
		});

		expect(sprite).toMatchObject({
			contentType: "image/webp",
			frameWidth: 256,
			frameHeight: 144,
			columns: 2,
			rows: 1,
		});
		expect(contentBytes(sprite.content)).toBe(FAKE_FRAME_BYTES.length);
	});

	test("rejects an unknown media file before touching ffmpeg", async () => {
		activeStubs.push(stubMethod(ffMpegService, "runToCompletion", () => Promise.reject(new Error("ffmpeg must not run"))));

		await expect(
			pluginFfmpegService.extractSprite({ mediaFileId: "missing", timeMs: [1_000], width: 256, height: 144, columns: 1 }),
		).rejects.toMatchObject({ code: "plugin.ffmpeg.media_not_found" });
	});
});

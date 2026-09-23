import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { serverConfig } from "@/server.config";
import { FileUtils } from "@/utils/file.utils";
import { pluginFfmpegService } from "./plugin.ffmpeg";

function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];
const OUTPUT_FILE_RE = /\.(webp|jpe?g)$/;

/** The service only stats/reads ffmpeg's output files, never decodes them —
 * the stub fakes a successful encode by writing bytes to every output path. */
function contentBytes(content: Blob | Uint8Array): number {
	return content instanceof Uint8Array ? content.byteLength : content.size;
}

function stubRunToCompletion(exitCode: number) {
	activeStubs.push(
		stubMethod(ffMpegService, "runToCompletion", (args: string[]) => {
			for (const arg of args) {
				if (OUTPUT_FILE_RE.test(arg)) writeFileSync(arg, Buffer.from([0x01, 0x02, 0x03]));
			}

			return Promise.resolve({ exitCode, stdout: new Uint8Array(), stderr: exitCode === 0 ? "" : "mock failure" });
		}),
	);
}

beforeEach(() => {
	activeStubs.length = 0;
	activeStubs.push(
		stubMethod(mediaRepository, "findByPrimaryId", () => Promise.resolve({ id: "mf-1", filePath: "/media/movie.mkv" })),
		stubMethod(FileUtils, "exists", () => Promise.resolve(true)),
	);
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

describe("pluginFfmpegService.extractFrame", () => {
	test("rejects an unknown media file", async () => {
		activeStubs.push(stubMethod(mediaRepository, "findByPrimaryId", () => Promise.resolve(undefined)));

		await expect(pluginFfmpegService.extractFrame({ mediaFileId: "missing", timeMs: 1_000, width: 320 })).rejects.toMatchObject({
			code: "plugin.ffmpeg.media_not_found",
		});
	});

	test("returns webp bytes for a successful extraction", async () => {
		stubRunToCompletion(0);

		const frame = await pluginFfmpegService.extractFrame({ mediaFileId: "mf-1", timeMs: 1_000, width: 320 });

		expect(frame.contentType).toBe("image/webp");
		expect(contentBytes(frame.content)).toBeGreaterThan(0);
	});

	test("cleans the temp output and reports process failures", async () => {
		stubRunToCompletion(1);
		const tempDir = serverConfig.paths.transcodeTmp;

		await expect(pluginFfmpegService.extractFrame({ mediaFileId: "mf-1", timeMs: 1_000, width: 320 })).rejects.toMatchObject({
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
			mediaFileId: "mf-1",
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
		expect(contentBytes(sprite.content)).toBeGreaterThan(0);
	});

	test("rejects an unknown media file before touching ffmpeg", async () => {
		activeStubs.push(stubMethod(mediaRepository, "findByPrimaryId", () => Promise.resolve(undefined)));
		activeStubs.push(stubMethod(ffMpegService, "runToCompletion", () => Promise.reject(new Error("ffmpeg must not run"))));

		await expect(
			pluginFfmpegService.extractSprite({ mediaFileId: "missing", timeMs: [1_000], width: 256, height: 144, columns: 1 }),
		).rejects.toMatchObject({ code: "plugin.ffmpeg.media_not_found" });
	});
});

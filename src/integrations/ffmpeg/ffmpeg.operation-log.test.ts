import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FfmpegOperationLog } from "@/integrations/ffmpeg/ffmpeg.operation-log";
import { removeTree } from "@/utils/directory.utils";
import { readFile } from "@/utils/file.utils";
import { currentLogDate } from "@/utils/logging/file-archive.utils";
import { joinPath } from "@/utils/path.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTree(directory)));
});

describe("FfmpegOperationLog", () => {
	it("stores the command, stderr, progress and exit details", async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), "reelvault-ffmpeg-log-"));
		temporaryDirectories.push(directory);
		const log = new FfmpegOperationLog({
			operationId: "session/1",
			mode: "transcode",
			inputPath: "/media/movie.mkv",
			outputPath: "/tmp/playlist.m3u8",
			command: ["ffmpeg", "-i", "/media/movie.mkv", "/tmp/playlist.m3u8"],
			logsDirectory: directory,
		});

		log.writeStderr("frame= 12 speed=1.2x");
		log.writeProgress("frame= 12 speed=1.2x");
		await log.finish(0, null);

		const content = await readFile(log.filePath, "utf8");
		expect(content).toContain("operationId: session/1");
		expect(content).toContain("mode: transcode");
		expect(content).toContain("command: 'ffmpeg' '-i' '/media/movie.mkv' '/tmp/playlist.m3u8'");
		expect(content).toContain("[stderr] frame= 12 speed=1.2x");
		expect(content).toContain("[progress] frame= 12 speed=1.2x");
		expect(content).toContain("exitCode: 0");
		expect(log.filePath).toContain(joinPath("ffmpeg", currentLogDate()));
	});
});

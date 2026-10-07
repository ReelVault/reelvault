import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { systemResourcesService } from "@/system/system-resources.service";
import { resolveStreamingThreads } from "./ffmpeg.threads";

const spies: Array<{ mockRestore(): void }> = [];

function budget(value: number): void {
	spies.push(spyOn(systemResourcesService, "getFfmpegThreads").mockReturnValue(value));
}

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("resolveStreamingThreads", () => {
	test("an explicit configuration always wins", () => {
		budget(8);

		expect(resolveStreamingThreads(4, 3)).toBe(4);
		expect(resolveStreamingThreads(2, 0)).toBe(2);
	});

	test("the first transcode keeps the full adaptive budget", () => {
		budget(8);

		// `activeTranscodes` already includes the process being started.
		expect(resolveStreamingThreads(0, 1)).toBe(8);
		expect(resolveStreamingThreads(0, 0)).toBe(8);
	});

	test("concurrent transcodes split the budget by the process count", () => {
		budget(8);

		expect(resolveStreamingThreads(0, 2)).toBe(4);
		expect(resolveStreamingThreads(0, 3)).toBe(2);
		expect(resolveStreamingThreads(0, 100)).toBe(1);
	});

	test("the adaptive budget stays capped for very large machines", () => {
		budget(64);

		expect(resolveStreamingThreads(0, 1)).toBe(8);
		expect(resolveStreamingThreads(0, 4)).toBe(8);
		expect(resolveStreamingThreads(0, 16)).toBe(4);
	});
});

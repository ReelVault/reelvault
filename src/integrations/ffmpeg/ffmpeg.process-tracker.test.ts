import { describe, expect, test } from "bun:test";
import { ffmpegProcessTracker, type TrackedProcess } from "./ffmpeg.process-tracker";

interface FakeProcess extends TrackedProcess {
	killCalls: string[];
	exited: Promise<number>;
	kill(signal: string): void;
}

const fakeProcess = (exited?: Promise<number>): FakeProcess => {
	const proc: FakeProcess = {
		killCalls: [],
		exited:
			exited ??
			new Promise<number>(() => {
				/* intentionally empty */
			}), // never exits on its own
		kill(signal: string) {
			proc.killCalls.push(signal);
		},
	};

	return proc;
};

describe("FFmpegProcessTracker", () => {
	test("killAllBackground terminates background processes but leaves streaming ones alive", () => {
		const background = fakeProcess();
		const streaming = fakeProcess();

		ffmpegProcessTracker.track(background, "background");
		ffmpegProcessTracker.track(streaming, "streaming");
		expect(ffmpegProcessTracker.backgroundCount).toBe(1);
		expect(ffmpegProcessTracker.activeCount).toBe(2);

		const killed = ffmpegProcessTracker.killAllBackground();

		expect(killed).toBe(1);
		expect(background.killCalls).toEqual(["SIGKILL"]);
		expect(streaming.killCalls).toEqual([]);
		expect(ffmpegProcessTracker.backgroundCount).toBe(0);
		// Streaming process still tracked
		expect(ffmpegProcessTracker.activeCount).toBe(1);
	});

	test("processes are untracked once they exit", async () => {
		let resolveExit: (code: number) => void = () => {
			/* intentionally empty */
		};
		const exitPromise = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const proc = fakeProcess(exitPromise);

		ffmpegProcessTracker.track(proc, "background");
		expect(ffmpegProcessTracker.activeCount).toBeGreaterThanOrEqual(1);

		resolveExit(0);
		// A macrotask flush lets the exited.finally handler run.
		await new Promise((resolve) => {
			setImmediate(resolve);
		});

		expect(ffmpegProcessTracker.backgroundCount).toBe(0);
	});

	test("counts and snapshots split by purpose including probe and diagnostic", () => {
		// The tracker is a process-wide singleton — start from a clean slate.
		ffmpegProcessTracker.killAll();
		const background = fakeProcess();
		const streaming = fakeProcess();
		const diagnostic = fakeProcess();

		ffmpegProcessTracker.track(background, "background", undefined, "subtitles");
		ffmpegProcessTracker.track(streaming, "streaming", undefined, "session-1");
		ffmpegProcessTracker.track({ ...fakeProcess(), pid: 4242 }, "probe");
		ffmpegProcessTracker.track(diagnostic, "diagnostic");

		const counts = ffmpegProcessTracker.counts();
		expect(counts).toMatchObject({ streaming: 1, background: 1, probe: 1, diagnostic: 1, total: 4 });
		expect(ffmpegProcessTracker.countByPurpose("probe")).toBe(1);
		expect(ffmpegProcessTracker.countByPurpose("diagnostic")).toBe(1);

		const snapshots = ffmpegProcessTracker.listProcesses();
		expect(snapshots).toHaveLength(4);
		const labeled = snapshots.find((s) => s.label === "session-1");
		expect(labeled?.purpose).toBe("streaming");
		const probed = snapshots.find((s) => s.purpose === "probe");
		expect(probed?.pid).toBe(4242);
		expect(probed?.runtimeMs).toBeGreaterThanOrEqual(0);

		expect(ffmpegProcessTracker.killAllBackground()).toBe(1);
		expect(ffmpegProcessTracker.counts()).toMatchObject({ streaming: 1, probe: 1, diagnostic: 1, total: 3 });

		ffmpegProcessTracker.killAll();
		expect(ffmpegProcessTracker.activeCount).toBe(0);
		expect(ffmpegProcessTracker.counts().total).toBe(0);
	});
});

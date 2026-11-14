import { describe, expect, test } from "bun:test";
import { MINUTE } from "@/config/server/server.constants";
import { STORAGE_FAILURE_WINDOW_MS, STORAGE_FILE_BLOCK_MS, STORAGE_ROOT_DEGRADED_MS, StorageHealthService } from "./storage-health.service";

const MOUNTS = ["/", "/library", "/library/bad", "/other"];

function createService(startAt = 1_000_000_000): { service: StorageHealthService; advance(ms: number): void } {
	let now = startAt;
	const service = new StorageHealthService({ now: () => now, mounts: () => MOUNTS });

	return {
		service,
		advance(ms) {
			now += ms;
		},
	};
}

describe("storage health: a single file", () => {
	test("blocks the file after two failures inside the window, without blocking its neighbours", () => {
		const { service } = createService();
		const broken = "/library/bad/movie.mkv";
		const healthy = "/library/bad/other.mkv";

		service.recordFailure(broken, "frame_timeout");
		expect(service.isFileBlocked(broken)).toBe(false);

		service.recordFailure(broken, "frame_timeout");
		expect(service.isFileBlocked(broken)).toBe(true);
		expect(service.isFileBlocked(healthy)).toBe(false);
		expect(service.isRootDegraded(broken)).toBe(false);
	});

	test("a success clears the file block", () => {
		const { service } = createService();
		const file = "/library/bad/movie.mkv";
		service.recordFailure(file, "frame_error");
		service.recordFailure(file, "frame_error");
		expect(service.isFileBlocked(file)).toBe(true);

		service.recordSuccess(file);

		expect(service.isFileBlocked(file)).toBe(false);
		expect(service.getSnapshot()).toEqual({ degradedRoots: [], blockedFiles: [] });
	});

	test("the block expires after the cooldown", () => {
		const { service, advance } = createService();
		const file = "/library/bad/movie.mkv";
		service.recordFailure(file, "frame_error");
		service.recordFailure(file, "frame_error");

		advance(STORAGE_FILE_BLOCK_MS - 1);
		expect(service.isFileBlocked(file)).toBe(true);

		advance(2);
		expect(service.isFileBlocked(file)).toBe(false);
	});

	test("a failure outside the window starts a new count", () => {
		const { service, advance } = createService();
		const file = "/library/bad/movie.mkv";

		service.recordFailure(file, "frame_error");
		advance(STORAGE_FAILURE_WINDOW_MS + 1);
		service.recordFailure(file, "frame_error");

		expect(service.isFileBlocked(file)).toBe(false);
	});
});

describe("storage health: a root", () => {
	test("is degraded once several distinct files fail, and other roots are unaffected", () => {
		const { service } = createService();
		const first = "/library/bad/one.mkv";
		const second = "/library/bad/two.mkv";
		const third = "/library/bad/three.mkv";
		const elsewhere = "/other/movie.mkv";

		for (const file of [first, first, second, second, third, third]) service.recordFailure(file, "grid_timeout");

		expect(service.isRootDegraded(first)).toBe(true);
		expect(service.isFileBlocked(first)).toBe(true);
		expect(service.isRootDegraded(elsewhere)).toBe(false);
		expect(service.isFileBlocked(elsewhere)).toBe(false);
	});

	test("does not degrade from one file failing many times", () => {
		const { service } = createService();
		const file = "/library/bad/movie.mkv";

		for (let attempt = 0; attempt < 6; attempt++) service.recordFailure(file, "grid_error");

		expect(service.isRootDegraded(file)).toBe(false);
		expect(service.isFileBlocked(file)).toBe(true);
	});

	test("a success clears the degradation", () => {
		const { service } = createService();
		const file = "/library/bad/movie.mkv";

		for (const path of [file, file, "/library/bad/two.mkv", "/library/bad/two.mkv", "/library/bad/three.mkv", "/library/bad/three.mkv"]) {
			service.recordFailure(path, "frame_timeout");
		}
		expect(service.isRootDegraded(file)).toBe(true);

		service.recordSuccess(file);

		expect(service.isRootDegraded(file)).toBe(false);
	});

	test("the degradation expires after its cooldown", () => {
		const { service, advance } = createService();
		const file = "/library/bad/movie.mkv";

		for (const path of [file, file, "/library/bad/two.mkv", "/library/bad/two.mkv", "/library/bad/three.mkv", "/library/bad/three.mkv"]) {
			service.recordFailure(path, "frame_timeout");
		}

		advance(STORAGE_ROOT_DEGRADED_MS + 1);

		expect(service.isRootDegraded(file)).toBe(false);
	});

	test("the snapshot reports the degraded root and the blocked files", () => {
		const { service } = createService();
		const files = ["/library/bad/one.mkv", "/library/bad/two.mkv", "/library/bad/three.mkv"];

		for (const file of files) {
			service.recordFailure(file, "read_timeout");
			service.recordFailure(file, "read_timeout");
		}

		const snapshot = service.getSnapshot();

		expect(snapshot.degradedRoots).toMatchObject([{ root: "/library/bad", failures: 6, distinctFiles: 3, reason: "read_timeout" }]);
		expect(snapshot.blockedFiles.map((entry) => entry.path).toSorted()).toEqual(files.toSorted());
	});
});

describe("storage health: mount resolution", () => {
	test("uses the longest matching mount point", () => {
		const { service } = createService();

		expect(service.getRootForPath("/library/bad/one.mkv")).toBe("/library/bad");
		expect(service.getRootForPath("/library/one.mkv")).toBe("/library");
		expect(service.getRootForPath("/elsewhere/one.mkv")).toBe("/");
		expect(service.getRootForPath("/other/one.mkv")).toBe("/other");
	});

	test("does not match a mount point that is only a path prefix", () => {
		const { service } = createService();

		expect(service.getRootForPath("/library-extra/one.mkv")).toBe("/");
	});

	test("a file failure is counted against its own mount, not the parent dataset", () => {
		const { service } = createService();
		const file = "/library/bad/one.mkv";

		service.recordFailure(file, "frame_error");
		service.recordFailure(file, "frame_error");

		const snapshot = service.getSnapshot();
		expect(snapshot.blockedFiles.map((entry) => entry.path)).toEqual([file]);
		expect(snapshot.degradedRoots).toEqual([]);
	});

	test("an old failure does not leak into a later window after minutes", () => {
		const { service, advance } = createService();
		const file = "/library/bad/one.mkv";

		service.recordFailure(file, "frame_error");
		advance(MINUTE);
		service.recordSuccess(file);

		expect(service.getSnapshot()).toEqual({ degradedRoots: [], blockedFiles: [] });
	});
});

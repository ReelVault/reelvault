import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { raceWithAbort } from "./ffprobe.builder";

describe("raceWithAbort abort handling", () => {
	test("detaches the abort listener once the probe settles", async () => {
		const controller = new AbortController();

		await expect(raceWithAbort(Promise.resolve("probed"), controller.signal)).resolves.toBe("probed");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	test("rejects with the abort reason and detaches the listener", async () => {
		const controller = new AbortController();
		const probe = Promise.withResolvers<string>();
		const racing = raceWithAbort(probe.promise, controller.signal);

		controller.abort(new Error("cancelled"));
		await expect(racing).rejects.toThrow("cancelled");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

		// A shared probe keeps running after one follower aborts — resolving late
		// must not throw into the void.
		probe.resolve("late");
	});

	test("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already gone"));

		await expect(raceWithAbort(Promise.resolve("probed"), controller.signal)).rejects.toThrow("already gone");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});

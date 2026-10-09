import { afterEach, expect, test } from "bun:test";
import { mediaService } from "@/application/media/media-files/media-files.service";
import { NotFoundError } from "@/utils/errors";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { episodesService } from "./episodes.service";
import { metadataService } from "./metadata/metadata.service";
import { peopleService } from "./people.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

/** A refresh that fails for `failingId` with a domain error, and for `strayId` with a raw error that must not leak. */
function refreshFailingFor(failingId: string, strayId: string) {
	return (id: string) => {
		if (id === failingId) return Promise.reject(new NotFoundError("Gone", { code: "catalog.not_found" }));
		if (id === strayId) return Promise.reject(new Error("/data/internal/path failed"));

		return Promise.resolve({ id });
	};
}

test("refreshes each person once and reports a failure by its code, never its message", async () => {
	const refresh = stubMethod(peopleService, "refresh", refreshFailingFor("p2", "p3"));
	stubs.push(refresh);

	const outcome = await peopleService.refreshMany(["p1", "p2", "p1", "p3"]);

	expect(refresh.calls).toEqual([["p1"], ["p2"], ["p3"]]);
	expect(outcome).toEqual({
		results: [
			{ id: "p1", ok: true },
			{ id: "p2", ok: false, code: "catalog.not_found" },
			{ id: "p3", ok: false, code: "person.refresh_failed" },
		],
	});
});

test("refreshes each episode once and reports a failure by its code, never its message", async () => {
	const refresh = stubMethod(episodesService, "refresh", refreshFailingFor("e2", "e3"));
	stubs.push(refresh);

	const outcome = await episodesService.refreshMany(["e1", "e2", "e3"]);

	expect(refresh.calls).toEqual([["e1"], ["e2"], ["e3"]]);
	expect(outcome).toEqual({
		results: [
			{ id: "e1", ok: true },
			{ id: "e2", ok: false, code: "catalog.not_found" },
			{ id: "e3", ok: false, code: "episode.refresh_failed" },
		],
	});
});

test("queues each media file once and reports a file that cannot be queued by its code", async () => {
	const refresh = stubMethod(mediaService, "refresh", refreshFailingFor("m2", "m3"));
	stubs.push(refresh);

	const outcome = await mediaService.refreshMany(["m1", "m2", "m3", "m1"]);

	expect(refresh.calls).toEqual([
		["m1", undefined],
		["m2", undefined],
		["m3", undefined],
	]);
	expect(outcome).toEqual({
		results: [
			{ id: "m1", ok: true },
			{ id: "m2", ok: false, code: "catalog.not_found" },
			{ id: "m3", ok: false, code: "media_file.refresh_failed" },
		],
	});
});

test("refreshes each title's artwork once and reports a failure by its code, never its message", async () => {
	const refresh = stubMethod(metadataService, "refreshImages", refreshFailingFor("m2", "m3"));
	stubs.push(refresh);

	const outcome = await metadataService.refreshImagesMany(["m1", "m2", "m1", "m3"]);

	expect(refresh.calls).toEqual([
		["m1", { force: true }],
		["m2", { force: true }],
		["m3", { force: true }],
	]);
	expect(outcome).toEqual({
		results: [
			{ id: "m1", ok: true },
			{ id: "m2", ok: false, code: "catalog.not_found" },
			{ id: "m3", ok: false, code: "metadata.refresh_images_failed" },
		],
	});
});

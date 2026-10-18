import { afterEach, expect, test } from "bun:test";
import { mediaService } from "@/app/media/media-files/media-files.service";
import { DomainError } from "@/utils/domain.errors";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { peopleService } from "./people.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

/** A refresh that fails for `failingId` with a domain error, and for `strayId` with a raw error that must not leak. */
function refreshFailingFor(failingId: string, strayId: string) {
	return (id: string) => {
		if (id === failingId) return Promise.reject(new DomainError("not_found", "Gone", { code: "catalog.not_found" }));
		if (id === strayId) return Promise.reject(new Error("/data/internal/path failed"));

		return Promise.resolve({ id });
	};
}

test("refreshes each person once and reports a failure by its code, never its message", async () => {
	stubs.push(stubMethod(peopleService, "refresh", refreshFailingFor("p2", "p3")));

	const outcome = await peopleService.refreshMany(["p1", "p2", "p1", "p3"]);

	expect(outcome).toEqual({
		results: [
			{ id: "p1", ok: true },
			{ id: "p2", ok: false, code: "catalog.not_found" },
			{ id: "p3", ok: false, code: "person.refresh_failed" },
		],
	});
});

test("queues each media file once and reports a file that cannot be queued by its code", async () => {
	stubs.push(stubMethod(mediaService, "refresh", refreshFailingFor("m2", "m3")));

	const outcome = await mediaService.refreshMany(["m1", "m2", "m3", "m1"]);

	expect(outcome).toEqual({
		results: [
			{ id: "m1", ok: true },
			{ id: "m2", ok: false, code: "catalog.not_found" },
			{ id: "m3", ok: false, code: "media_file.refresh_failed" },
		],
	});
});

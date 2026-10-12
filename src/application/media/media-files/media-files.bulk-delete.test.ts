import { afterEach, expect, test } from "bun:test";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { DomainError } from "@/utils/errors";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { mediaService } from "./media-files.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

test("holds a bulk delete back while a stream plays one of the files, and deletes nothing", async () => {
	stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: "f1" }]));
	const remove = stubMethod(mediaService, "delete", () => Promise.resolve({ success: true }));
	stubs.push(remove);

	await expect(mediaService.deleteMany(["f1", "f2"])).rejects.toMatchObject({
		code: "media.delete_blocked_active_streams",
		params: { activeStreams: 1 },
	});
	expect(remove.calls).toEqual([]);
});

test("deletes the files once the admin forces it, and reports a failure by its code", async () => {
	stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: "f1" }]));
	const remove = stubMethod(mediaService, "delete", (id: string) => {
		if (id === "f2") return Promise.reject(new DomainError("not_found", "Gone", { code: "media.not_found" }));

		return Promise.resolve({ success: true });
	});
	stubs.push(remove);

	const outcome = await mediaService.deleteMany(["f1", "f2", "f1"], { force: true });

	expect(remove.calls).toEqual([
		["f1", undefined],
		["f2", undefined],
	]);
	expect(outcome).toEqual({
		results: [
			{ id: "f1", ok: true },
			{ id: "f2", ok: false, code: "media.not_found" },
		],
	});
});

import { afterEach, expect, test } from "bun:test";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { metadataService } from "./metadata/metadata.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

test("holds a bulk title delete back while a stream plays one of the title's files", async () => {
	stubs.push(stubMethod(mediaRepository, "findIdsByMetadataIds", () => Promise.resolve(["f1"])));
	stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: "f1" }]));
	const remove = stubMethod(metadataService, "delete", () => Promise.resolve({ success: true }));
	stubs.push(remove);

	await expect(metadataService.deleteMany(["m1"])).rejects.toMatchObject({
		code: "metadata.delete_blocked_active_streams",
		params: { activeStreams: 1 },
	});
	expect(remove.calls).toEqual([]);
});

test("deletes the titles once the admin forces it, and reports each title's outcome", async () => {
	stubs.push(stubMethod(mediaRepository, "findIdsByMetadataIds", () => Promise.resolve(["f1"])));
	stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: "f1" }]));
	const remove = stubMethod(metadataService, "delete", () => Promise.resolve({ success: true }));
	stubs.push(remove);

	const outcome = await metadataService.deleteMany(["m1", "m2"], { force: true });

	expect(remove.calls).toEqual([
		["m1", undefined],
		["m2", undefined],
	]);
	expect(outcome).toEqual({
		results: [
			{ id: "m1", ok: true },
			{ id: "m2", ok: true },
		],
	});
});

test("does not hold back a title when nothing plays one of its files", async () => {
	stubs.push(stubMethod(mediaRepository, "findIdsByMetadataIds", () => Promise.resolve(["f1"])));
	stubs.push(stubMethod(streamingManager, "getAllActiveSessions", () => [{ mediaFileId: "f9" }]));
	const remove = stubMethod(metadataService, "delete", () => Promise.resolve({ success: true }));
	stubs.push(remove);

	const outcome = await metadataService.deleteMany(["m1"]);

	expect(remove.calls).toEqual([["m1", undefined]]);
	expect(outcome).toEqual({ results: [{ id: "m1", ok: true }] });
});

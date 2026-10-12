import { afterEach, expect, test } from "bun:test";
import { DomainError } from "@/utils/errors";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { subtitlesService } from "./subtitles.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

test("bulk delete removes each subtitle once and reports a failed one by its code, never its message", async () => {
	const remove = stubMethod(subtitlesService, "delete", (id: string) =>
		id === "sub-missing"
			? Promise.reject(new DomainError("not_found", "Subtitle /data/subs/x.srt is gone", { code: "subtitle.not_found" }))
			: Promise.resolve({ success: true }),
	);
	stubs.push(remove);

	const outcome = await subtitlesService.bulkDelete(["sub-1", "sub-missing", "sub-1", "sub-2"]);

	expect(remove.calls).toEqual([["sub-1"], ["sub-missing"], ["sub-2"]]);
	expect(outcome).toEqual({
		results: [
			{ id: "sub-1", ok: true },
			{ id: "sub-missing", ok: false, code: "subtitle.not_found" },
			{ id: "sub-2", ok: true },
		],
	});
});

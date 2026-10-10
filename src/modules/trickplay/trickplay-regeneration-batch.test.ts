import { afterEach, expect, test } from "bun:test";
import { trickplayRepository } from "@/database/repositories/trickplay.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { trickplayService } from "./trickplay.service";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
	activeStubs.length = 0;
});

const filesByTitle: Record<string, string[]> = {
	"t-1": ["a", "b"],
	"t-2": ["c", "d"],
	"t-3": ["e"],
};

test("a regeneration over several titles keeps scope order and stops at the cap in total", async () => {
	const calls: Array<{ id: string; limit: number }> = [];
	activeStubs.push(
		stubMethod(trickplayRepository, "findMediaFileIdsForRegeneration", (scope: { id: string }, _force: boolean, limit: number) => {
			calls.push({ id: scope.id, limit });

			return Promise.resolve((filesByTitle[scope.id] ?? []).slice(0, limit));
		}),
	);

	const ids = await trickplayService.findMediaFileIdsForRegenerations(
		[
			{ kind: "title", id: "t-1" },
			{ kind: "title", id: "t-2" },
			{ kind: "title", id: "t-3" },
		],
		false,
		3,
	);

	expect(ids).toEqual(["a", "b", "c"]);
	// The third title is never asked for: the cap was already reached by the first two.
	expect(calls).toEqual([
		{ id: "t-1", limit: 3 },
		{ id: "t-2", limit: 1 },
	]);
});

test("the matching count of several titles is the sum over the scopes", async () => {
	const counts: Record<string, number> = { "t-1": 2, "t-2": 5 };
	activeStubs.push(
		stubMethod(trickplayRepository, "countForRegeneration", (scope: { id: string }) => Promise.resolve(counts[scope.id] ?? 0)),
	);

	const total = await trickplayService.countForRegenerations(
		[
			{ kind: "title", id: "t-1" },
			{ kind: "title", id: "t-2" },
		],
		true,
	);

	expect(total).toBe(7);
});

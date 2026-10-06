import { afterEach, describe, expect, test } from "bun:test";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { collectionRepository } from "./collections.repository";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("collectionRepository.findPage count cache", () => {
	test("serves the grouped count from the cache on a repeated page", async () => {
		const countCalls: number[] = [];
		activeStubs.push(
			stubMethod(collectionRepository, "countWithMinimumMetadata", () => {
				countCalls.push(1);

				return Promise.resolve(1);
			}),
			// Empty page ids short-circuit before findMany, so the count is the only
			// statement under test.
			stubMethod(collectionRepository, "findPageIdsWithMinimumMetadata", () => Promise.resolve([])),
		);

		// Unique name filter keeps the key distinct from other tests sharing the
		// process-global count cache.
		const query = { limit: 24, name: `cache-probe-${Math.random().toString(36).slice(2)}` };
		await collectionRepository.findPage(query);
		await collectionRepository.findPage(query);

		expect(countCalls).toHaveLength(1);
	});
});

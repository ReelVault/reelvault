import { describe, expect, test } from "bun:test";
import { PromiseTimeoutError } from "@/utils/promise.utils";
import { mapProvidersSafely } from "./fan-out.service";

describe("mapProvidersSafely", () => {
	test("reports a provider that misses its deadline and omits its result", async () => {
		const errors: unknown[] = [];

		const results = await mapProvidersSafely(
			["org.example.provider"],
			() =>
				new Promise<number>(() => {
					// Never settles: the provider budget is the behavior under test.
				}),
			(_provider, error) => {
				errors.push(error);
			},
			1,
			20,
		);

		expect(results).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(PromiseTimeoutError);
	});
});

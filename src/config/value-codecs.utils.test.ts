import { describe, expect, test } from "bun:test";
import { createValueCodecs } from "./value-codecs.utils";

describe("boolean value codec", () => {
	const codec = createValueCodecs().boolean();

	test("rejects a value that is not a boolean with null", () => {
		expect(codec.parse("yes")).toBeNull();
	});
});

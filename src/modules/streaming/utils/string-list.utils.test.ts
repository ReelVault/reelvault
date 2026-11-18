import { describe, expect, test } from "bun:test";
import { normalizeStringList } from "./string-list.utils";

describe("string list normalization", () => {
	test("drops blank entries after trimming and lowercasing", () => {
		expect(normalizeStringList([" H264 ", "", "  ", "h264", null, 5])).toEqual(["h264"]);
	});
});

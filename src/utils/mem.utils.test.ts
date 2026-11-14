import { describe, expect, test } from "bun:test";
import { parseZfsArcReclaimableKiB } from "./mem.utils";

describe("parseZfsArcReclaimableKiB", () => {
	test("subtracts the ARC minimum from its current size", () => {
		const stats = [
			"13 1 0x01 99 4320 3853502592 1234",
			"name                            type data",
			"hits                            4    100",
			"size                            4    8388608",
			"c_min                           4    2097152",
			"c_max                           4    12582912",
		].join("\n");

		expect(parseZfsArcReclaimableKiB(stats)).toBe(6144);
	});

	test("reports nothing when the ARC is already at its minimum", () => {
		const stats = ["size 4 2000000", "c_min 4 2000000"].join("\n");

		expect(parseZfsArcReclaimableKiB(stats)).toBeUndefined();
	});

	test("reports nothing when the counters are missing", () => {
		expect(parseZfsArcReclaimableKiB("name type data\nhits 4 100")).toBeUndefined();
	});
});

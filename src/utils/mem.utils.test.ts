import { describe, expect, test } from "bun:test";
import {
	BatchGarbageCollector,
	capTotalMemoryKiB,
	isMemoryCacheEntryFresh,
	parseCgroupLimitKiB,
	parseCgroupUsageKiB,
	parseMeminfoAvailableKiB,
	parseMeminfoTotalKiB,
	parseZfsArcReclaimableKiB,
} from "./mem.utils";

const MEMINFO = ["MemTotal:       16384000 kB", "MemFree:         1234567 kB", "MemAvailable:    8192000 kB"].join("\n");

describe("parseMeminfoTotalKiB", () => {
	test("reads the total RAM line", () => {
		expect(parseMeminfoTotalKiB(MEMINFO)).toBe(16_384_000);
	});

	test("reports nothing when the line is missing or zero", () => {
		expect(parseMeminfoTotalKiB("MemFree: 1234 kB")).toBeUndefined();
		expect(parseMeminfoTotalKiB("MemTotal: 0 kB")).toBeUndefined();
		expect(parseMeminfoTotalKiB("")).toBeUndefined();
	});
});

describe("parseMeminfoAvailableKiB", () => {
	test("reads the available RAM line", () => {
		expect(parseMeminfoAvailableKiB(MEMINFO)).toBe(8_192_000);
	});

	test("reports nothing when the line is missing or zero", () => {
		expect(parseMeminfoAvailableKiB("MemTotal: 16384000 kB")).toBeUndefined();
		expect(parseMeminfoAvailableKiB("MemAvailable: 0 kB")).toBeUndefined();
	});
});

describe("parseCgroupLimitKiB", () => {
	test("converts a v2 byte limit to KiB", () => {
		expect(parseCgroupLimitKiB("1073741824", "v2")).toBe(1_048_576);
		expect(parseCgroupLimitKiB("1536", "v2")).toBe(1);
	});

	test("treats v2 max and non-positive values as no limit", () => {
		expect(parseCgroupLimitKiB("max", "v2")).toBeUndefined();
		expect(parseCgroupLimitKiB("0", "v2")).toBeUndefined();
		expect(parseCgroupLimitKiB("-1", "v2")).toBeUndefined();
	});

	test("treats the v1 unlimited sentinel as no limit", () => {
		expect(parseCgroupLimitKiB("9223372032559808512", "v1")).toBeUndefined();
		expect(parseCgroupLimitKiB("1073741824", "v1")).toBe(1_048_576);
	});
});

describe("parseCgroupUsageKiB", () => {
	test("converts a usage counter to KiB", () => {
		expect(parseCgroupUsageKiB("1073741824")).toBe(1_048_576);
		expect(parseCgroupUsageKiB("1536")).toBe(1);
	});

	test("keeps zero and rejects negative or unreadable counters", () => {
		expect(parseCgroupUsageKiB("0")).toBe(0);
		expect(parseCgroupUsageKiB("-1")).toBeUndefined();
		expect(parseCgroupUsageKiB("current")).toBeUndefined();
	});
});

describe("isMemoryCacheEntryFresh", () => {
	test("a host fact is reused inside the TTL and re-read once the quota window passes", () => {
		// Five minutes, pinned as a literal: reusing the exported constant here
		// would make the expected value a recomputation of the subject.
		expect(isMemoryCacheEntryFresh(0, 1_000)).toBeFalse();
		expect(isMemoryCacheEntryFresh(1_000, 1_000 + 299_999)).toBeTrue();
		expect(isMemoryCacheEntryFresh(1_000, 1_000 + 300_000)).toBeFalse();
	});
});

describe("capTotalMemoryKiB", () => {
	test("uses the cgroup limit when it is stricter", () => {
		expect(capTotalMemoryKiB(8_192_000, 4_194_304)).toBe(4_194_304);
	});

	test("keeps the host reading when there is no limit", () => {
		expect(capTotalMemoryKiB(8_192_000, undefined)).toBe(8_192_000);
	});

	test("uses the limit when the host reading is unknown", () => {
		expect(capTotalMemoryKiB(undefined, 4_194_304)).toBe(4_194_304);
		expect(capTotalMemoryKiB(undefined, undefined)).toBeUndefined();
	});
});

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

	test("rounds a partial KiB down", () => {
		const stats = ["size 4 2097153", "c_min 4 2097152"].join("\n");

		expect(parseZfsArcReclaimableKiB(stats)).toBe(0);
	});

	test("reports nothing when the ARC is already at its minimum", () => {
		const stats = ["size 4 2000000", "c_min 4 2000000"].join("\n");

		expect(parseZfsArcReclaimableKiB(stats)).toBeUndefined();
	});

	test("reports nothing when the counters are missing", () => {
		expect(parseZfsArcReclaimableKiB("name type data\nhits 4 100")).toBeUndefined();
	});
});

describe("BatchGarbageCollector", () => {
	test("collects once every 25 ticks by default", () => {
		let collections = 0;
		const collector = new BatchGarbageCollector(undefined, () => collections++);

		for (let tick = 0; tick < 24; tick++) collector.tick();
		expect(collections).toBe(0);

		collector.tick();
		expect(collections).toBe(1);

		for (let tick = 0; tick < 24; tick++) collector.tick();
		expect(collections).toBe(1);

		collector.tick();
		expect(collections).toBe(2);
	});

	test("honors a custom interval", () => {
		let collections = 0;
		const collector = new BatchGarbageCollector(3, () => collections++);

		collector.tick();
		collector.tick();
		expect(collections).toBe(0);

		collector.tick();
		expect(collections).toBe(1);
	});
});

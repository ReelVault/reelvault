import { describe, expect, test } from "bun:test";
import { useTimeZone } from "../../../tests/helpers/time-zone.helper";
import { recentDayKeys } from "./analytics.utils";

// Europe/Berlin moves its clock forward on 2026-03-29 (02:00 to 03:00).
useTimeZone("Europe/Berlin");

describe("recentDayKeys", () => {
	test("lists each local calendar day once across the spring clock change", () => {
		const now = new Date(2026, 2, 30, 0, 30);

		expect(recentDayKeys(3, now)).toEqual(["2026-03-28", "2026-03-29", "2026-03-30"]);
	});
});

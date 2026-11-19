import { describe, expect, test } from "bun:test";
import { shouldRequestSystemdRestart } from "./restart.scheduler";

describe("shouldRequestSystemdRestart", () => {
	test("hands the restart to systemd only for a process systemd started", () => {
		expect(shouldRequestSystemdRestart("system", true)).toBe(true);
		expect(shouldRequestSystemdRestart("user", true)).toBe(true);
	});

	test("uses the in-process restart when no unit is registered or systemd did not start us", () => {
		expect(shouldRequestSystemdRestart(null, true)).toBe(false);
		expect(shouldRequestSystemdRestart("system", false)).toBe(false);
		expect(shouldRequestSystemdRestart("user", false)).toBe(false);
	});
});

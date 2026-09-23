import { describe, expect, test } from "bun:test";
import { FULL_PROBE_BUDGET, probeBudgetForFormat } from "./ffprobe.probe-budgets";

describe("probe budgets", () => {
	test("tiers probe budgets by container format", () => {
		const mp4 = probeBudgetForFormat("mov,mp4,m4a,3gp,3g2,mj2");
		expect(mp4.analyzeduration).toBe("10M");
		expect(mp4.probesize).toBe("10M");

		const mkv = probeBudgetForFormat("matroska,webm");
		expect(mkv.analyzeduration).toBe("20M");
		expect(mkv.probesize).toBe("20M");

		const exotic = probeBudgetForFormat("mpegts");
		expect(exotic.analyzeduration).toBe(FULL_PROBE_BUDGET.analyzeduration);
		expect(exotic.probesize).toBe(FULL_PROBE_BUDGET.probesize);

		const missing = probeBudgetForFormat(null);
		expect(missing.probesize).toBe(FULL_PROBE_BUDGET.probesize);
	});
});

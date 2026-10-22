import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { insertResourceMetrics } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminResourcesService } from "./admin-resources.service";

// Metric samples are real rows; the export reads them back through the repository.
const db = useTestDatabase();

const MINUTE = 60_000;
// The export window is measured from the current time, so the clock is pinned. Stored timestamps have
// whole-second precision, and both samples sit on whole seconds of this fixed instant.
const NOW = Date.parse("2026-01-01T12:00:00.000Z");

afterEach(() => {
	setSystemTime();
});

describe("AdminResourcesService.exportHistory", () => {
	test("exports samples inside the window unthinned, quoting separators, and leaves out older samples", async () => {
		setSystemTime(new Date(NOW));
		const sampledAt = new Date(NOW - 10 * MINUTE);
		const old = new Date(NOW - 3 * 60 * MINUTE);
		await insertResourceMetrics(db.client(), {
			id: "sample-1",
			cpuUsedPercent: 12.5,
			cpuLoadAvg1: 0.4,
			cpuLoadAvg5: 0.3,
			cpuLoadAvg15: 0.2,
			memoryUsedMb: 4096,
			memoryTotalMb: 8192,
			memoryPercent: 40,
			diskUsedGb: 61,
			diskTotalGb: 100,
			diskPercent: 61,
			pressure: "low",
			activeStreams: 0,
			activeWorkers: { scanning: 2, transcode: 1 },
			retentionUntil: new Date(NOW + 60 * MINUTE),
			createdAt: sampledAt,
			updatedAt: sampledAt,
		});
		await insertResourceMetrics(db.client(), {
			id: "sample-old",
			cpuUsedPercent: 1,
			cpuLoadAvg1: 0,
			cpuLoadAvg5: 0,
			cpuLoadAvg15: 0,
			memoryUsedMb: 1,
			memoryTotalMb: 2,
			memoryPercent: 50,
			diskUsedGb: 1,
			diskTotalGb: 2,
			diskPercent: 50,
			pressure: "low",
			activeWorkers: {},
			retentionUntil: new Date(NOW + 60 * MINUTE),
			createdAt: old,
			updatedAt: old,
		});

		const exported = await adminResourcesService.exportHistory(2, "csv");

		expect(exported.filename).toBe("resources-2h.csv");
		expect(exported.contentType).toBe("text/csv; charset=utf-8");
		expect(exported.body.trimEnd().split("\n")).toEqual([
			"timestamp,cpuPercent,memoryPercent,diskPercent,pressure,activeWorkers",
			`2026-01-01T11:50:00.000Z,12.5,40,61,low,"{""scanning"":2,""transcode"":1}"`,
		]);
	});
});

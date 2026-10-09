import { afterEach, describe, expect, test } from "bun:test";
import { resourceMetricsRepository } from "@/database/repositories/resource-metrics.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminResourcesService } from "./admin-resources.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubSamples() {
	const history = stubMethod(resourceMetricsRepository, "getHistory", () =>
		Promise.resolve([
			{
				id: "sample-1",
				createdAt: new Date("2026-10-09T10:00:00Z"),
				cpuUsedPercent: 12.5,
				memoryPercent: 40,
				diskPercent: 61,
				pressure: "low",
				activeWorkers: { scanning: 2, transcode: 1 },
			},
		]),
	);
	stubs.push(history);

	return history;
}

describe("AdminResourcesService.exportHistory", () => {
	test("exports every sample unthinned, quoting cells that contain separators", async () => {
		const history = stubSamples();

		const exported = await adminResourcesService.exportHistory(2, "csv");

		expect(history.calls).toEqual([[2, Number.POSITIVE_INFINITY]]);
		expect(exported.filename).toBe("resources-2h.csv");
		expect(exported.contentType).toBe("text/csv; charset=utf-8");
		const [header, row] = exported.body.trimEnd().split("\n");
		expect(header).toBe("timestamp,cpuPercent,memoryPercent,diskPercent,pressure,activeWorkers");
		expect(row).toBe('2026-10-09T10:00:00.000Z,12.5,40,61,low,"{""scanning"":2,""transcode"":1}"');
	});

	test("JSON export carries the same samples as an array", async () => {
		stubSamples();

		const exported = await adminResourcesService.exportHistory(24, "json");
		const rows = JSON.parse(exported.body) as Array<{ cpuPercent: number; activeWorkers: string }>;

		expect(exported.filename).toBe("resources-24h.json");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ cpuPercent: 12.5 });
		expect(JSON.parse(rows[0]?.activeWorkers ?? "null")).toEqual({ scanning: 2, transcode: 1 });
	});
});

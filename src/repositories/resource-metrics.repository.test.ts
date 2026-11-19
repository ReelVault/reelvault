import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { resourceMetricsRepository } from "./resource-metrics.repository";

const { client } = useTestDatabase();

function seedMetrics(clientReturn: ReturnType<typeof client>, count: number): void {
	const now = Date.now();
	const rows = Array.from({ length: count }, (_, index) => {
		const createdAt = new Date(now - index * 60_000);

		return {
			id: `metric-${index}`,
			createdAt,
			updatedAt: createdAt,
			cpuUsedPercent: index,
			cpuLoadAvg1: 0,
			cpuLoadAvg5: 0,
			cpuLoadAvg15: 0,
			memoryUsedMb: 0,
			memoryTotalMb: 100,
			memoryPercent: 0,
			diskUsedGb: 0,
			diskTotalGb: 100,
			diskPercent: 0,
			pressure: "low",
			activeStreams: 0,
			activeWorkers: {},
			retentionUntil: new Date(now + 60_000),
		};
	});

	clientReturn.insert(schema.resourceMetrics).values(rows).run();
}

describe("ResourceMetricsRepository", () => {
	test("thins a 24 h history to the requested point budget", async () => {
		seedMetrics(client(), 100);

		const history = await resourceMetricsRepository.getHistory(24, 10);

		expect(history).toHaveLength(10);
		expect(history[0]?.id).toBe("metric-0");
	});

	test("keeps every sample when the point budget is infinite", async () => {
		seedMetrics(client(), 100);

		const history = await resourceMetricsRepository.getHistory(24, Number.POSITIVE_INFINITY);

		expect(history).toHaveLength(100);
	});
});

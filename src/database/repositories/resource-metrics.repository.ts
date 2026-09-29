import { desc, gte, lt, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { DAY, HOUR } from "@/server.constants";

const metrics = schema.resourceMetrics;

type ResourceMetricRecord = typeof metrics.$inferSelect;

interface CreateResourceMetricInput {
	cpuUsedPercent: number;
	cpuLoadAvg1: number;
	cpuLoadAvg5: number;
	cpuLoadAvg15: number;
	memoryUsedMb: number;
	memoryTotalMb: number;
	memoryPercent: number;
	diskUsedGb: number;
	diskTotalGb: number;
	diskPercent: number;
	pressure: string;
	activeStreams: number;
	activeWorkers: Record<string, number>;
}

export interface ResourceHistorySample {
	id: string;
	createdAt: Date;
	cpuUsedPercent: number;
	memoryPercent: number;
	diskPercent: number;
	pressure: string;
	activeWorkers: Record<string, number>;
}

class ResourceMetricsRepository {
	async create(input: CreateResourceMetricInput): Promise<ResourceMetricRecord> {
		const retentionUntil = new Date(Date.now() + DAY); // 24h
		const [record] = await databaseFactory
			.getClient()
			.insert(metrics)
			.values({ ...input, retentionUntil })
			.returning();
		if (!record) throw new Error("Failed to create resource metric");

		return record;
	}

	async getHistory(hours = 24, maxPoints = 480): Promise<ResourceHistorySample[]> {
		const cutoff = new Date(Date.now() - hours * HOUR);
		const rows = await databaseFactory
			.getClient()
			.select({
				id: metrics.id,
				createdAt: metrics.createdAt,
				cpuUsedPercent: metrics.cpuUsedPercent,
				memoryPercent: metrics.memoryPercent,
				diskPercent: metrics.diskPercent,
				pressure: metrics.pressure,
				activeWorkers: metrics.activeWorkers,
			})
			.from(metrics)
			.where(gte(metrics.createdAt, cutoff))
			.orderBy(desc(metrics.createdAt));
		// Even stride over the newest-first rows keeps the newest sample and bounds
		// the payload for charts — a 24 h window at ~30 s cadence spans thousands of
		// rows, far past what a graph can render.
		const stride = Math.max(1, Math.ceil(rows.length / maxPoints));

		return rows.filter((_, index) => index % stride === 0);
	}

	async getAggregates(hours = 24): Promise<{
		avgCpu: number;
		maxCpu: number;
		avgMemory: number;
		maxMemory: number;
		avgDisk: number;
		maxDisk: number;
		snapshotCount: number;
	}> {
		const cutoff = new Date(Date.now() - hours * HOUR);
		const [result] = await databaseFactory
			.getClient()
			.select({
				avgCpu: sql<number>`AVG(${metrics.cpuUsedPercent})`,
				maxCpu: sql<number>`MAX(${metrics.cpuUsedPercent})`,
				avgMemory: sql<number>`AVG(${metrics.memoryPercent})`,
				maxMemory: sql<number>`MAX(${metrics.memoryPercent})`,
				avgDisk: sql<number>`AVG(${metrics.diskPercent})`,
				maxDisk: sql<number>`MAX(${metrics.diskPercent})`,
				snapshotCount: sql<number>`COUNT(*)`,
			})
			.from(metrics)
			.where(gte(metrics.createdAt, cutoff));

		return {
			avgCpu: result?.avgCpu ?? 0,
			maxCpu: result?.maxCpu ?? 0,
			avgMemory: result?.avgMemory ?? 0,
			maxMemory: result?.maxMemory ?? 0,
			avgDisk: result?.avgDisk ?? 0,
			maxDisk: result?.maxDisk ?? 0,
			snapshotCount: result?.snapshotCount ?? 0,
		};
	}

	async cleanupOlderThan(cutoff: Date): Promise<number> {
		const result = await databaseFactory.getClient().delete(metrics).where(lt(metrics.retentionUntil, cutoff));

		return result.changes;
	}
}

export const resourceMetricsRepository = new ResourceMetricsRepository();

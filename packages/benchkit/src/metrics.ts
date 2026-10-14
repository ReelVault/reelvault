/** One task-reported number; `higherIsBetter` drives the direction of its baseline verdict. */
export interface TaskMetric {
	value: number;
	higherIsBetter: boolean;
}

/** Flattened metric map a task can return under `data.metrics` for baseline comparison. */
export type TaskMetrics = Record<string, TaskMetric>;

/** One metric entry; `higherIsBetter` is false for latencies, memory and CPU cost. */
export function metric(value: number, higherIsBetter: boolean): TaskMetric {
	return { value, higherIsBetter };
}

/** True for plain objects — the shape task metrics are keyed by. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is a metric map — every entry a finite value plus a direction. */
export function isTaskMetrics(value: unknown): value is TaskMetrics {
	if (!isRecordValue(value)) return false;

	for (const entry of Object.values(value)) {
		if (!isRecordValue(entry)) return false;
		if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) return false;
		if (typeof entry.higherIsBetter !== "boolean") return false;
	}

	return true;
}

/** The metric map a task returned under `data.metrics`, or undefined when it returned none. */
export function metricsOf(data: unknown): TaskMetrics | undefined {
	if (typeof data !== "object" || data === null || !("metrics" in data)) return undefined;

	return isTaskMetrics(data.metrics) ? data.metrics : undefined;
}

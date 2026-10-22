import type { TrickplayRegenerationReport } from "@reelvault/sdk/common";
import type { RegenerationOutcomeRow } from "@/repositories/trickplay.repository";

/**
 * Folds the job counts of one regeneration operation into the admin report. A completed job whose result says the
 * artifact storage budget ran out is counted on its own, so the admin sees what the budget left out.
 */
export function summarizeRegenerationOutcomes(operationId: string, rows: readonly RegenerationOutcomeRow[]): TrickplayRegenerationReport {
	const report: TrickplayRegenerationReport = {
		operationId,
		total: 0,
		generated: 0,
		skippedStorageBudget: 0,
		skippedOther: 0,
		failed: 0,
		cancelled: 0,
		unfinished: 0,
	};

	for (const row of rows) {
		report.total += row.count;
		switch (row.status) {
			case "completed":
				if (row.skipped === "storage-budget") report.skippedStorageBudget += row.count;
				else if (row.skipped) report.skippedOther += row.count;
				else report.generated += row.count;
				break;
			case "failed":
				report.failed += row.count;
				break;
			case "cancelled":
				report.cancelled += row.count;
				break;
			case "pending":
			case "running":
				report.unfinished += row.count;
				break;
			default:
				break;
		}
	}

	return report;
}

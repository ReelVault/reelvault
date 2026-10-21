import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { workerJobRepository } from "@/repositories/worker.repository";
import { safeParseJson } from "@/utils/json.utils";

/**
 * Result payload of a completed worker operation's first job, validated against
 * `schema`; null when the job stored no result or the payload does not match.
 */
export async function readCompletedOperationResult<TSchemaType extends TSchema>(
	operationId: string,
	schema: TSchemaType,
): Promise<Static<TSchemaType> | null> {
	const [job] = await workerJobRepository.findByOperation(operationId, 1);
	if (!job?.result) return null;

	// A damaged result row must read as "no result", not crash the endpoint.
	const parsed = safeParseJson(job.result);

	return Value.Check(schema, parsed) ? parsed : null;
}

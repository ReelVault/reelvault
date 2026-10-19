import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { workerJobRepository } from "@/app/repositories/worker.repository";

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

	const parsed: unknown = JSON.parse(job.result);

	return Value.Check(schema, parsed) ? parsed : null;
}

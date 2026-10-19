import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { isNullish } from "@/utils/type.utils";

/** Marks the post-create sidecar write so a retry does not repeat it. */
export async function markIngestSidecarWritten(mediaFileId: string): Promise<void> {
	await upsertIngestState(mediaFileId, { sidecarWrittenAt: new Date() });
}

/** Marks the `media.file.discovered` emission so a retry does not duplicate it. */
export async function markIngestDiscoveredEmitted(mediaFileId: string): Promise<void> {
	await upsertIngestState(mediaFileId, { discoveredEmittedAt: new Date() });
}

/** Which post-create ingest side effects already ran for this file. */
export async function findIngestProgress(mediaFileId: string): Promise<{ sidecarWritten: boolean; discoveredEmitted: boolean }> {
	const [row] = await databaseFactory
		.getClient()
		.select({
			sidecarWrittenAt: schema.mediaFileIngestState.sidecarWrittenAt,
			discoveredEmittedAt: schema.mediaFileIngestState.discoveredEmittedAt,
		})
		.from(schema.mediaFileIngestState)
		.where(eq(schema.mediaFileIngestState.mediaFileId, mediaFileId))
		.limit(1);

	return { sidecarWritten: !isNullish(row?.sidecarWrittenAt), discoveredEmitted: !isNullish(row?.discoveredEmittedAt) };
}

async function upsertIngestState(mediaFileId: string, values: { sidecarWrittenAt?: Date; discoveredEmittedAt?: Date }): Promise<void> {
	const now = new Date();
	await databaseFactory
		.getClient()
		.insert(schema.mediaFileIngestState)
		.values({ mediaFileId, createdAt: now, updatedAt: now, ...values })
		.onConflictDoUpdate({
			target: schema.mediaFileIngestState.mediaFileId,
			set: { ...values, updatedAt: now },
		});
}

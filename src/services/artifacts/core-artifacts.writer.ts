import type { PlaybackArtifact, PlaybackArtifactWrite } from "@reelvault/sdk/common";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { assertCoreArtifactsBudget } from "@/modules/artifacts/artifacts-budget.utils";
import { mediaArtifactsService } from "./media-artifacts.service";

export interface CoreArtifactWriteOptions {
	/**
	 * Bytes of the previous generation this write replaces. They stay on disk
	 * until the new set is complete, but the budget may count them as reclaimed.
	 */
	reclaimedBytes?: number | undefined;
}

/** Writes a built-in (non-plugin) playback artifact under the core artifacts budget. */
export async function writeCoreArtifact(artifact: PlaybackArtifactWrite, options?: CoreArtifactWriteOptions): Promise<PlaybackArtifact> {
	const reclaimedBytes = options?.reclaimedBytes ?? 0;

	return await mediaArtifactsService.write(CORE_ARTIFACTS_OWNER, artifact, {
		assertWithinQuota: (_ownerId, bytesAfterWrite, incomingBytes) =>
			assertCoreArtifactsBudget(bytesAfterWrite, incomingBytes, undefined, reclaimedBytes),
	});
}

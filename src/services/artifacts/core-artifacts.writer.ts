import type { PlaybackArtifact, PlaybackArtifactWrite } from "@reelvault/sdk/common";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { assertCoreArtifactsBudget } from "@/modules/artifacts/artifacts-budget.utils";
import { mediaArtifactsService } from "./media-artifacts.service";

/** Writes a built-in (non-plugin) playback artifact under the core artifacts budget. */
export async function writeCoreArtifact(artifact: PlaybackArtifactWrite): Promise<PlaybackArtifact> {
	return await mediaArtifactsService.write(CORE_ARTIFACTS_OWNER, artifact, {
		assertWithinQuota: (_ownerId, bytesAfterWrite, incomingBytes) => assertCoreArtifactsBudget(bytesAfterWrite, incomingBytes),
	});
}

import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";

/** The artifact kind written by the built-in generator; plugins may write previews under their own owner. */
export const TRICKPLAY_ARTIFACT_KIND = "trickplay";

/** Whether an artifact belongs to the core trickplay generation rather than a plugin preview. */
export function isCoreTrickplayArtifact(artifact: { pluginId: string; kind: string }): boolean {
	return artifact.pluginId === CORE_ARTIFACTS_OWNER && artifact.kind === TRICKPLAY_ARTIFACT_KIND;
}

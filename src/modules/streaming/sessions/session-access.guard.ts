import type { SessionAccessInfo } from "../runtime/sessions/session-store";
import { playbackStreamingService } from "../streaming.service";
import { assertActiveStreamAccess, assertSessionOwnership, resolveSessionAccess } from "./stream-access";

/**
 * Resolves a live session and asserts it belongs to the active profile. This is
 * the light gate used where the plugin stream-access policy is not required.
 */
export function assertSessionOwnershipById(sessionId: string, profileId?: string): SessionAccessInfo {
	const session = resolveSessionAccess(
		sessionId,
		(id) => playbackStreamingService.getSessionAccess(id),
		(id) => playbackStreamingService.getTerminatedSession(id),
	);
	assertSessionOwnership(session, profileId);

	return session;
}

/** Full HTTP gate: session ownership plus the plugin stream-access policy. */
export async function assertSessionAccess(sessionId: string, userId?: string, profileId?: string): Promise<SessionAccessInfo> {
	const session = assertSessionOwnershipById(sessionId, profileId);
	await assertActiveStreamAccess({ userId, profileId, mediaFileId: session.mediaFileId });

	return session;
}

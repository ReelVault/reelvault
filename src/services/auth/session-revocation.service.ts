import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { sessionsRepository } from "@/repositories/sessions.repository";

/**
 * Ends every session of the users. The rows go first, then the cached session
 * verifications (a cached hit would keep a revoked token alive for the cache TTL)
 * and finally the open sockets.
 */
export async function revokeUserSessions(userIds: string[]): Promise<number> {
	const revoked = await sessionsRepository.deleteForUsers(userIds);
	invalidateSessionCache();
	for (const userId of userIds) realtimeService.disconnectUser(userId);

	return revoked;
}

/** Ends one session of a user, with the same cache and socket cleanup as {@link revokeUserSessions}. */
export async function revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
	const revoked = await sessionsRepository.deleteForUser({ userId, sessionId });
	invalidateSessionCache();
	realtimeService.disconnectAuthSession(sessionId);

	return revoked;
}

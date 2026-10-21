import type { ActiveSessionsResponse, PaginationQuery } from "@reelvault/sdk/common";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { sessionsRepository } from "@/repositories/sessions.repository";
import { assertPresent, assertUserId, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

export const sessionsService = {
	serviceName: "SessionsService",
	logger: createLogger("SessionsService"),

	async list(headers?: Headers, currentSessionId?: string, userId?: string, query?: PaginationQuery): Promise<ActiveSessionsResponse> {
		return await runSafely(sessionsService, "list", async () => {
			assertUserId(userId);
			assertPresent(headers, "Request headers are required to list sessions");

			const sessions = await sessionsRepository.findActivePageByUserId(userId, query);
			const data = sessions.data.map((session) => ({
				id: session.id,
				ipAddress: session.ipAddress ?? null,
				userAgent: session.userAgent ?? null,
				createdAt: session.createdAt.toISOString(),
				updatedAt: session.updatedAt.toISOString(),
				expiresAt: session.expiresAt.toISOString(),
				isCurrent: session.id === currentSessionId,
			}));

			return { ...sessions, data };
		});
	},

	async revoke(sessionId: string, headers?: Headers, currentSessionId?: string, userId?: string): Promise<{ success: boolean }> {
		return await runSafely(sessionsService, "revoke", async () => {
			assertUserId(userId);
			assertPresent(headers, "Request headers are required to revoke a session");
			if (sessionId === currentSessionId) {
				throw new DomainError("forbidden", "Use logout to revoke the current session", { code: "auth.current_session_revoke_forbidden" });
			}

			const token = await sessionsRepository.findTokenByIdAndUserId({ sessionId, userId });
			if (!token) {
				throw new DomainError("not_found", "Session not found", { code: "auth.session_not_found", params: { sessionId } });
			}

			await betterAuthApi.revokeSession({ token, headers });
			realtimeService.sendToSession(sessionId, "auth:session:revoked", { sessionId });
			// Actually terminate the socket — the event alone left it fully usable.
			realtimeService.disconnectAuthSession(sessionId);

			return { success: true };
		});
	},

	async revokeOthers(headers?: Headers, currentSessionId?: string, userId?: string): Promise<{ success: boolean }> {
		return await runSafely(sessionsService, "revokeOthers", async () => {
			assertUserId(userId);
			assertPresent(headers, "Request headers are required to revoke other sessions");
			assertPresent(currentSessionId, "Current session id is required to revoke other sessions");

			await sessionsRepository.deleteOtherSessions({ userId, currentSessionId });
			// Bypasses betterAuthApi, so invalidate the session cache explicitly.
			invalidateSessionCache();

			// Close the revoked sockets so "log out everywhere" is immediate, not
			// masked by the cookie cache / open WebSockets.
			realtimeService.disconnectUser(userId, currentSessionId);

			return { success: true };
		});
	},
};

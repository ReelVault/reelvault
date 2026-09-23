import type { ActiveSessionsResponse, PaginationQuery } from "@reelvault/sdk/common";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { realtimeService } from "@/modules/realtime";
import { BaseService } from "@/utils/base-service";
import { ForbiddenError, NotFoundError } from "@/utils/errors";

class SessionsService extends BaseService {
	constructor() {
		super("SessionsService");
	}

	async list(headers?: Headers, currentSessionId?: string, userId?: string, query?: PaginationQuery): Promise<ActiveSessionsResponse> {
		return await this.safeExecute("list", async () => {
			this.assertExists(headers, "Request headers", "list sessions");
			this.assertExists(userId, "User", "list sessions");

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
	}

	async revoke(sessionId: string, headers?: Headers, currentSessionId?: string, userId?: string): Promise<{ success: boolean }> {
		return await this.safeExecute("revoke", async () => {
			this.assertExists(headers, "Request headers", "revoke session");
			this.assertExists(userId, "User", "revoke session");
			if (sessionId === currentSessionId) throw new ForbiddenError("Use logout to revoke the current session");

			const token = await sessionsRepository.findTokenByIdAndUserId({ sessionId, userId });
			if (!token) throw new NotFoundError("Session not found");

			await betterAuthApi.revokeSession({ token, headers });
			realtimeService.sendToSession(sessionId, "auth:session:revoked", { sessionId });
			// Actually terminate the socket — the event alone left it fully usable.
			realtimeService.disconnectAuthSession(sessionId);

			return { success: true };
		});
	}

	async revokeOthers(headers?: Headers, currentSessionId?: string, userId?: string): Promise<{ success: boolean }> {
		return await this.safeExecute("revokeOthers", async () => {
			this.assertExists(headers, "Request headers", "revoke other sessions");
			this.assertExists(currentSessionId, "Session", "revoke other sessions");
			this.assertExists(userId, "User", "revoke other sessions");

			await sessionsRepository.deleteOtherSessions({ userId, currentSessionId });
			// Bypasses betterAuthApi, so invalidate the session cache explicitly.
			invalidateSessionCache();

			// Close the revoked sockets so "log out everywhere" is immediate, not
			// masked by the cookie cache / open WebSockets.
			realtimeService.disconnectUser(userId, currentSessionId);

			return { success: true };
		});
	}
}

export const sessionsService = new SessionsService();

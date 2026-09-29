import type { ActiveSessionsResponse, PaginationQuery } from "@reelvault/sdk/common";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { BaseService } from "@/utils/base-service";
import { ForbiddenError, NotFoundError } from "@/utils/errors";

class SessionsService extends BaseService {
	constructor() {
		super("SessionsService");
	}

	async list(headers?: Headers, currentSessionId?: string, userId?: string, query?: PaginationQuery): Promise<ActiveSessionsResponse> {
		return await this.safeExecute("list", async () => {
			this.assertPresent(headers, "Request headers are required to list sessions");
			this.assertUserId(userId);

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
			this.assertPresent(headers, "Request headers are required to revoke a session");
			this.assertUserId(userId);
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
			this.assertPresent(headers, "Request headers are required to revoke other sessions");
			this.assertPresent(currentSessionId, "Current session id is required to revoke other sessions");
			this.assertUserId(userId);

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

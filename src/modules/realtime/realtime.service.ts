import type { PlaybackCommand, RealtimeEventMessage, RealtimeEventName, RealtimePayload } from "@reelvault/sdk/common";
import { usersRepository } from "@/database/repositories/users.repository";
import { BaseService } from "@/utils/base-service";
import { ClientConnection } from "./connection/client-connection";
import { ConnectionRegistry } from "./connection/connection-registry";
import { CLIENT_STALE_TIMEOUT_MS, STALE_SWEEP_INTERVAL_MS } from "./realtime.constants";
import type { ClientConnectionInput, RealtimeStats } from "./realtime.types";

export class RealtimeService extends BaseService {
	private readonly registry = new ConnectionRegistry();
	private readonly startedAt = Date.now();
	private totalMessagesSent = 0;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super("RealtimeService");
		this.startStaleSweep();
	}

	register(input: ClientConnectionInput): void {
		const connection = new ClientConnection(input);
		this.registry.add(connection);
		this.logger.debug("Realtime connection registered", {
			connectionId: input.connectionId,
			userId: input.userId,
			profileId: input.profileId,
			totalConnections: this.registry.count(),
		});
	}

	unregister(connectionId: string): void {
		const removed = this.registry.remove(connectionId);
		if (removed) {
			this.logger.debug("Realtime connection unregistered", {
				connectionId,
				totalConnections: this.registry.count(),
			});
		}
	}

	touch(connectionId: string): void {
		const connection = this.registry.get(connectionId);
		connection?.touch();
	}

	subscribeToPlaybackSession(connectionId: string, sessionId: string): boolean {
		const success = this.registry.subscribePlaybackSession(connectionId, sessionId);
		if (success) {
			this.logger.debug("Connection subscribed to playback session", {
				connectionId,
				sessionId,
			});
		}

		return success;
	}

	unsubscribeFromPlaybackSession(connectionId: string, sessionId: string): void {
		this.registry.unsubscribePlaybackSession(connectionId, sessionId);
		this.logger.debug("Connection unsubscribed from playback session", {
			connectionId,
			sessionId,
		});
	}

	dropPlaybackSession(playbackSessionId: string): void {
		this.registry.dropPlaybackSession(playbackSessionId);
	}

	/**
	 * Closes every socket authenticated with the given auth session (revoke /
	 * logout). Without this, a revoked session keeps receiving realtime events and
	 * sending playback commands until the 60 s stale sweep.
	 */
	disconnectAuthSession(sessionId: string, reason = "Session revoked"): number {
		let closed = 0;
		for (const conn of this.registry.findConnectionsBySession(sessionId)) {
			// `clientsBySession` also indexes playback subscriptions — only close
			// connections whose AUTH session matches.
			if (conn.sessionId !== sessionId) continue;

			conn.close(4001, reason);
			this.unregister(conn.connectionId);
			closed++;
		}

		return closed;
	}

	/** Closes every socket of a user (ban, password change), optionally sparing one auth session. */
	disconnectUser(userId: string, exceptSessionId?: string): number {
		let closed = 0;
		for (const conn of this.registry.findConnectionsByUser(userId)) {
			if (exceptSessionId && conn.sessionId === exceptSessionId) continue;

			conn.close(4001, "Session revoked");
			this.unregister(conn.connectionId);
			closed++;
		}

		return closed;
	}

	isSubscribedToPlaybackSession(connectionId: string, playbackSessionId: string): boolean {
		return this.registry.isSubscribed(connectionId, playbackSessionId);
	}

	getConnectedCount(): number {
		return this.registry.count();
	}

	sendToUser<E extends RealtimeEventName>(userId: string, type: E, payload: RealtimePayload<E>): void {
		const connections = this.registry.findConnectionsByUser(userId);
		if (connections.length === 0) return;

		const message = this.serializeMessage(type, payload);
		this.dispatch(connections, message);
	}

	sendToProfile<E extends RealtimeEventName>(profileId: string, type: E, payload: RealtimePayload<E>): void {
		const connections = this.registry.findConnectionsByProfile(profileId);
		if (connections.length === 0) return;

		const message = this.serializeMessage(type, payload);
		this.dispatch(connections, message);
	}

	/**
	 * System-level events (rescue state, resource alerts) carry no user data but
	 * are admin-panel material — non-admin connections must not receive them.
	 */
	async sendToAdmins<E extends RealtimeEventName>(type: E, payload: RealtimePayload<E>): Promise<void> {
		if (this.registry.count() === 0) return;

		const connections = [...this.registry.getAll()];
		const adminIds = await usersRepository.findAdminIdsByUserIds(connections.map((connection) => connection.userId));
		const adminConnections = connections.filter((connection) => adminIds.has(connection.userId));
		if (adminConnections.length === 0) return;

		const message = this.serializeMessage(type, payload);
		this.dispatch(adminConnections, message);
	}

	sendToSession<E extends RealtimeEventName>(sessionId: string, type: E, payload: RealtimePayload<E>): void {
		const connections = this.registry.findConnectionsBySession(sessionId);
		if (connections.length === 0) return;

		const message = this.serializeMessage(type, payload);
		this.dispatch(connections, message);
	}

	broadcast<E extends RealtimeEventName>(type: E, payload: RealtimePayload<E>): void {
		if (this.registry.count() === 0) return;

		const message = this.serializeMessage(type, payload);
		this.dispatch(this.registry.getAll(), message);
	}

	sendPlaybackCommand(targetSessionId: string, command: PlaybackCommand, senderProfileId?: string): boolean {
		const connections = this.registry.findConnectionsBySession(targetSessionId);
		if (connections.length === 0) return false;

		const message = this.serializeMessage("playback:command", {
			sessionId: targetSessionId,
			command,
			senderProfileId,
		});

		let deliveredCount = 0;
		for (const conn of connections) {
			if (conn.safeSend(message)) {
				deliveredCount++;
				this.totalMessagesSent++;
			} else {
				// A failed send means a broken socket — drop it like `dispatch` does.
				this.unregister(conn.connectionId);
			}
		}

		return deliveredCount > 0;
	}

	getStats(): RealtimeStats {
		const regStats = this.registry.getStats();

		return {
			...regStats,
			totalMessagesSent: this.totalMessagesSent,
			uptimeMs: Date.now() - this.startedAt,
		};
	}

	shutdown(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}

		for (const conn of this.registry.getAll()) {
			conn.close(1001, "Server shutdown");
		}
	}

	private serializeMessage(type: string, payload: unknown): string {
		const event: RealtimeEventMessage = {
			type,
			payload,
			occurredAt: new Date().toISOString(),
		};

		return JSON.stringify(event);
	}

	private dispatch(connections: Iterable<ClientConnection>, message: string): void {
		for (const conn of connections) {
			if (conn.safeSend(message)) {
				this.totalMessagesSent++;
			} else {
				// Failed send indicates broken socket; unregister eagerly
				this.unregister(conn.connectionId);
			}
		}
	}

	private startStaleSweep(): void {
		this.sweepTimer = setInterval(() => {
			const now = Date.now();
			for (const conn of this.registry.getAll()) {
				if (now - conn.lastActiveAt > CLIENT_STALE_TIMEOUT_MS) {
					this.logger.debug("Reaping stale realtime client connection", { connectionId: conn.connectionId });
					conn.close(1000, "Stale heartbeat");
					this.registry.remove(conn.connectionId);
				}
			}
		}, STALE_SWEEP_INTERVAL_MS);
		this.sweepTimer.unref();
	}
}

export const realtimeService = new RealtimeService();

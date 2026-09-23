import { MAX_SESSION_SUBSCRIPTIONS_PER_CONNECTION } from "../realtime.constants";
import type { ClientConnection } from "./client-connection";

export class ConnectionRegistry {
	private readonly clients = new Map<string, ClientConnection>();
	private readonly clientsByUser = new Map<string, Set<string>>();
	private readonly clientsByProfile = new Map<string, Set<string>>();
	private readonly clientsBySession = new Map<string, Set<string>>();
	/** connectionId -> Set<playbackSessionId> */
	private readonly sessionSubscriptions = new Map<string, Set<string>>();

	add(client: ClientConnection): void {
		this.clients.set(client.connectionId, client);
		this.index(this.clientsByUser, client.userId, client.connectionId);
		if (client.profileId) this.index(this.clientsByProfile, client.profileId, client.connectionId);

		if (client.sessionId) this.index(this.clientsBySession, client.sessionId, client.connectionId);
	}

	remove(connectionId: string): ClientConnection | undefined {
		const client = this.clients.get(connectionId);
		if (!client) return undefined;

		this.clients.delete(connectionId);
		this.removeIndex(this.clientsByUser, client.userId, connectionId);
		if (client.profileId) this.removeIndex(this.clientsByProfile, client.profileId, connectionId);

		if (client.sessionId) this.removeIndex(this.clientsBySession, client.sessionId, connectionId);

		const subs = this.sessionSubscriptions.get(connectionId);
		if (subs) {
			this.sessionSubscriptions.delete(connectionId);
			for (const sessionId of subs) {
				this.removeIndex(this.clientsBySession, sessionId, connectionId);
			}
		}

		return client;
	}

	get(connectionId: string): ClientConnection | undefined {
		return this.clients.get(connectionId);
	}

	has(connectionId: string): boolean {
		return this.clients.has(connectionId);
	}

	getAll(): IterableIterator<ClientConnection> {
		return this.clients.values();
	}

	count(): number {
		return this.clients.size;
	}

	subscribePlaybackSession(connectionId: string, playbackSessionId: string): boolean {
		if (!this.clients.has(connectionId)) return false;

		let subs = this.sessionSubscriptions.get(connectionId);
		if (!subs) {
			subs = new Set();
			this.sessionSubscriptions.set(connectionId, subs);
		}

		if (!subs.has(playbackSessionId) && subs.size >= MAX_SESSION_SUBSCRIPTIONS_PER_CONNECTION) {
			return false;
		}

		subs.add(playbackSessionId);
		this.index(this.clientsBySession, playbackSessionId, connectionId);

		return true;
	}

	unsubscribePlaybackSession(connectionId: string, playbackSessionId: string): void {
		this.sessionSubscriptions.get(connectionId)?.delete(playbackSessionId);
		this.removeIndex(this.clientsBySession, playbackSessionId, connectionId);
	}

	dropPlaybackSession(playbackSessionId: string): void {
		const connIds = this.clientsBySession.get(playbackSessionId);
		if (!connIds) return;

		this.clientsBySession.delete(playbackSessionId);
		for (const connId of connIds) {
			this.sessionSubscriptions.get(connId)?.delete(playbackSessionId);
		}
	}

	isSubscribed(connectionId: string, playbackSessionId: string): boolean {
		return this.sessionSubscriptions.get(connectionId)?.has(playbackSessionId) ?? false;
	}

	findConnectionsByUser(userId: string): ClientConnection[] {
		return this.collect(this.clientsByUser.get(userId));
	}

	findConnectionsByProfile(profileId: string): ClientConnection[] {
		return this.collect(this.clientsByProfile.get(profileId));
	}

	findConnectionsBySession(sessionId: string): ClientConnection[] {
		return this.collect(this.clientsBySession.get(sessionId));
	}

	getStats() {
		return {
			totalConnections: this.clients.size,
			uniqueUsers: this.clientsByUser.size,
			uniqueProfiles: this.clientsByProfile.size,
			uniquePlaybackSessions: this.clientsBySession.size,
		};
	}

	private collect(ids?: Set<string>): ClientConnection[] {
		if (!ids || ids.size === 0) return [];

		const result: ClientConnection[] = [];
		for (const id of ids) {
			const conn = this.clients.get(id);
			if (conn) result.push(conn);
		}

		return result;
	}

	private index(map: Map<string, Set<string>>, key: string, connectionId: string): void {
		let set = map.get(key);
		if (!set) {
			set = new Set();
			map.set(key, set);
		}

		set.add(connectionId);
	}

	private removeIndex(map: Map<string, Set<string>>, key: string, connectionId: string): void {
		const set = map.get(key);
		if (!set) return;

		set.delete(connectionId);
		if (set.size === 0) map.delete(key);
	}
}

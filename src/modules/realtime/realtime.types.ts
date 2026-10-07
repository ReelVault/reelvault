export interface RealtimeSocket {
	/** Bun returns `-1` when the message is dropped because the socket buffer is full. */
	send(data: string): number | undefined;
	close?(code?: number, reason?: string): void;
	readonly readyState?: number;
}

export interface ClientConnectionInput {
	readonly connectionId: string;
	readonly userId: string;
	readonly profileId?: string | null | undefined;
	readonly sessionId?: string | null | undefined;
	readonly socket: RealtimeSocket;
}

export interface RealtimeStats {
	readonly totalConnections: number;
	readonly uniqueUsers: number;
	readonly uniqueProfiles: number;
	readonly uniquePlaybackSessions: number;
	readonly totalMessagesSent: number;
	readonly uptimeMs: number;
}

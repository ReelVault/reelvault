export interface RealtimeSocket {
	send(data: string): void;
	close?(code?: number, reason?: string): void;
	readonly readyState?: number;
}

export interface ClientConnectionInput {
	readonly connectionId: string;
	readonly userId: string;
	readonly profileId?: string | null | undefined;
	readonly sessionId?: string | null | undefined;
	readonly socket: RealtimeSocket;
	readonly connectedAt?: Date;
}

export interface RealtimeStats {
	readonly totalConnections: number;
	readonly uniqueUsers: number;
	readonly uniqueProfiles: number;
	readonly uniquePlaybackSessions: number;
	readonly totalMessagesSent: number;
	readonly uptimeMs: number;
}

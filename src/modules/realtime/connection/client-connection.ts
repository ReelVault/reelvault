import type { ClientConnectionInput, RealtimeSocket } from "../realtime.types";

export class ClientConnection {
	readonly connectionId: string;
	readonly userId: string;
	profileId: string | null;
	readonly sessionId: string | null;
	private readonly socket: RealtimeSocket;
	readonly connectedAt: Date;
	lastActiveAt: number;
	messagesSent = 0;

	constructor(input: ClientConnectionInput) {
		this.connectionId = input.connectionId;
		this.userId = input.userId;
		this.profileId = input.profileId ?? null;
		this.sessionId = input.sessionId ?? null;
		this.socket = input.socket;
		this.connectedAt = input.connectedAt ?? new Date();
		this.lastActiveAt = Date.now();
	}

	touch(): void {
		this.lastActiveAt = Date.now();
	}

	safeSend(serializedMessage: string): boolean {
		try {
			if (typeof this.socket.readyState === "number" && this.socket.readyState > 1) {
				return false;
			}

			this.socket.send(serializedMessage);
			this.messagesSent++;
			this.lastActiveAt = Date.now();

			return true;
		} catch {
			return false;
		}
	}

	close(code = 1000, reason = "Normal closure"): void {
		try {
			this.socket.close?.(code, reason);
		} catch {
			// Sockets can already be terminated
		}
	}
}

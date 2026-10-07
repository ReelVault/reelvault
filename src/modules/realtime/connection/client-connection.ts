import type { ClientConnectionInput, RealtimeSocket } from "../realtime.types";

/** Bun `send` sentinel: the message was dropped because the socket buffer is full. */
const WS_BUFFER_FULL = -1;
/** Consecutive drops after which the connection is closed so the client resyncs on reconnect. */
const MAX_CONSECUTIVE_DROPS = 5;
/** WebSocket close code "Try Again Later". */
const WS_CLOSE_TRY_AGAIN_LATER = 1013;

export type SendOutcome = "delivered" | "dropped" | "closed";

export class ClientConnection {
	readonly connectionId: string;
	readonly userId: string;
	profileId: string | null;
	readonly sessionId: string | null;
	private readonly socket: RealtimeSocket;
	private consecutiveDrops = 0;
	lastActiveAt: number;

	constructor(input: ClientConnectionInput) {
		this.connectionId = input.connectionId;
		this.userId = input.userId;
		this.profileId = input.profileId ?? null;
		this.sessionId = input.sessionId ?? null;
		this.socket = input.socket;
		this.lastActiveAt = Date.now();
	}

	touch(): void {
		this.lastActiveAt = Date.now();
	}

	safeSend(serializedMessage: string): SendOutcome {
		try {
			if (typeof this.socket.readyState === "number" && this.socket.readyState > 1) {
				return "closed";
			}

			const result = this.socket.send(serializedMessage);
			if (result === WS_BUFFER_FULL) {
				// Backpressure: the message never reached the client. Do not refresh
				// lastActiveAt — a socket that never drains must not look active to the
				// stale sweep, and after enough drops we close it so the client
				// reconnects and resynchronizes instead of silently missing events.
				this.consecutiveDrops++;
				if (this.consecutiveDrops >= MAX_CONSECUTIVE_DROPS) {
					this.close(WS_CLOSE_TRY_AGAIN_LATER, "Client too slow");
					return "closed";
				}

				return "dropped";
			}

			this.consecutiveDrops = 0;
			this.lastActiveAt = Date.now();

			return "delivered";
		} catch {
			return "closed";
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

import { afterEach, describe, expect, test } from "bun:test";
import { type ProtocolSocket, wsProtocol } from "./ws-protocol.service";

interface SocketDouble {
	socket: ProtocolSocket;
	sent: string[];
}

const openSockets: ProtocolSocket[] = [];

function connect(): SocketDouble {
	const sent: string[] = [];
	const socket: ProtocolSocket = {
		raw: {
			send() {
				return 1;
			},
			close() {
				return undefined;
			},
		},
		send(data: string) {
			sent.push(data);

			return 1;
		},
		close() {
			return undefined;
		},
	};
	openSockets.push(socket);
	wsProtocol.onOpen(socket, { userId: "user-1", profileId: "profile-1", sessionId: null });

	return { socket, sent };
}

afterEach(() => {
	for (const socket of openSockets.splice(0)) wsProtocol.onClose(socket);
});

function pingFrameOfLength(length: number): string {
	const prefix = '{"type":"ping","pad":"';
	const suffix = '"}';

	return `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`;
}

describe("wsProtocol inbound frame size", () => {
	test("answers a ping frame at the 16,384-character limit", async () => {
		const { socket, sent } = connect();
		const frame = pingFrameOfLength(16_384);
		expect(frame.length).toBe(16_384);

		await wsProtocol.onMessage(socket, frame, "user-1");

		expect(sent.map((message) => JSON.parse(message).type)).toEqual(["pong"]);
	});

	test("ignores a ping frame one character over the 16,384-character limit", async () => {
		const { socket, sent } = connect();
		const frame = pingFrameOfLength(16_385);
		expect(frame.length).toBe(16_385);

		await wsProtocol.onMessage(socket, frame, "user-1");

		expect(sent).toEqual([]);
	});
});

describe("wsProtocol playback commands", () => {
	test("replies with a not_found error for a command on an unknown session", async () => {
		const { socket, sent } = connect();

		await wsProtocol.onMessage(
			socket,
			JSON.stringify({ type: "playback_command", sessionId: "missing-session", command: { type: "play" }, requestId: "req-1" }),
			"user-1",
		);

		expect(sent.map((message) => JSON.parse(message))).toEqual([
			expect.objectContaining({ type: "playback_command_error", sessionId: "missing-session", error: "not_found", requestId: "req-1" }),
		]);
	});
});

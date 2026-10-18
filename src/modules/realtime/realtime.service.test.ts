import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RealtimeService } from "./realtime.service";

/**
 * A socket that records what the server wrote and closed. `sendResult` scripts the
 * return value of each `send`: -1 means Bun dropped the message (buffer full).
 */
function recordingSocket(sendResult: () => number | undefined = () => 1) {
	const messages: string[] = [];
	const closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
	const socket = {
		send: (message: string) => {
			const result = sendResult();
			if (result !== -1) messages.push(message);

			return result;
		},
		close: (code?: number, reason?: string) => {
			closes.push({ code, reason });
		},
	};

	return { socket, messages, closes };
}

function messageTypes(messages: string[]): string[] {
	return messages.map((message) => JSON.parse(message).type);
}

let service: RealtimeService;

beforeEach(() => {
	service = new RealtimeService();
});

afterEach(() => {
	service.shutdown();
});

describe("RealtimeService delivery", () => {
	test("delivers user, profile and broadcast messages only to the connections they target", () => {
		const user1 = recordingSocket();
		const user2 = recordingSocket();
		service.register({ connectionId: "conn-1", userId: "user-1", profileId: "profile-1", sessionId: "session-1", socket: user1.socket });
		service.register({ connectionId: "conn-2", userId: "user-2", profileId: "profile-2", sessionId: "session-2", socket: user2.socket });

		service.sendToUser("user-1", "library:scan:completed", { libraryId: "lib-1" });
		service.sendToProfile("profile-2", "notification:created", { id: "notif-1" });
		service.broadcast("system:ping", {});

		expect(messageTypes(user1.messages)).toEqual(["library:scan:completed", "system:ping"]);
		expect(messageTypes(user2.messages)).toEqual(["notification:created", "system:ping"]);
		expect(service.getStats().totalMessagesSent).toBe(4);
	});

	test("an unregistered connection receives nothing", () => {
		const conn = recordingSocket();
		service.register({ connectionId: "conn-1", userId: "user-1", socket: conn.socket });

		service.unregister("conn-1");
		service.broadcast("system:ping", {});

		expect(conn.messages).toEqual([]);
		expect(service.getConnectedCount()).toBe(0);
	});

	test("broadcastToAdmins reaches only admin connections", () => {
		const admin = recordingSocket();
		const viewer = recordingSocket();
		service.register({ connectionId: "conn-admin", userId: "user-admin", isAdmin: true, socket: admin.socket });
		service.register({ connectionId: "conn-viewer", userId: "user-viewer", socket: viewer.socket });

		service.broadcastToAdmins("worker:progress", { jobId: "job-1", workerId: "library-scan", percent: 42 });

		expect(messageTypes(admin.messages)).toEqual(["worker:progress"]);
		expect(viewer.messages).toEqual([]);
	});

	test("playback commands reach only connections subscribed to the playback session", () => {
		const player = recordingSocket();
		service.register({ connectionId: "conn-player", userId: "user-test", profileId: "profile-test", socket: player.socket });

		expect(service.sendPlaybackCommand("play-sess-1", { type: "play" })).toBe(false);
		expect(service.subscribeToPlaybackSession("conn-player", "play-sess-1")).toBe(true);
		expect(service.sendPlaybackCommand("play-sess-1", { type: "seek", relative: -10 }, "remote-profile")).toBe(true);

		expect(player.messages.map((message) => JSON.parse(message))).toEqual([
			expect.objectContaining({
				type: "playback:command",
				payload: expect.objectContaining({ command: { type: "seek", relative: -10 }, senderProfileId: "remote-profile" }),
			}),
		]);

		service.unsubscribeFromPlaybackSession("conn-player", "play-sess-1");
		expect(service.sendPlaybackCommand("play-sess-1", { type: "pause" })).toBe(false);
		expect(player.messages).toHaveLength(1);
	});
});

describe("RealtimeService backpressure", () => {
	test("closes a client after five consecutive dropped sends, not before", () => {
		const slow = recordingSocket(() => -1);
		service.register({ connectionId: "conn-slow", userId: "user-slow", profileId: "profile-slow", socket: slow.socket });

		for (let attempt = 0; attempt < 4; attempt++) service.broadcast("system:ping", {});
		expect(slow.closes).toEqual([]);
		expect(service.getConnectedCount()).toBe(1);

		service.broadcast("system:ping", {});
		expect(slow.closes).toEqual([{ code: 1013, reason: "Client too slow" }]);
		expect(service.getConnectedCount()).toBe(0);
		expect(service.getStats().totalMessagesSent).toBe(0);
	});

	test("a delivered message resets the drop streak", () => {
		let sendResult = -1;
		const flaky = recordingSocket(() => sendResult);
		service.register({ connectionId: "conn-flaky", userId: "user-flaky", socket: flaky.socket });

		for (let attempt = 0; attempt < 4; attempt++) service.broadcast("system:ping", {});
		sendResult = 1;
		service.broadcast("system:ping", {});
		sendResult = -1;
		for (let attempt = 0; attempt < 4; attempt++) service.broadcast("system:ping", {});

		expect(flaky.closes).toEqual([]);
		expect(service.getConnectedCount()).toBe(1);
		expect(messageTypes(flaky.messages)).toEqual(["system:ping"]);
	});
});

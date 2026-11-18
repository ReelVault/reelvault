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

	test("delivers to a socket whose readyState is open", () => {
		const open = recordingSocket();
		Object.assign(open.socket, { readyState: 1 });
		service.register({ connectionId: "conn-open", userId: "user-open", socket: open.socket });

		service.broadcast("system:ping", {});

		expect(messageTypes(open.messages)).toEqual(["system:ping"]);
		expect(service.getConnectedCount()).toBe(1);
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

	test("reports an undelivered playback command when the subscriber's socket drops it", () => {
		const dropped = recordingSocket(() => -1);
		service.register({ connectionId: "conn-dropped", userId: "user-dropped", socket: dropped.socket });
		service.subscribeToPlaybackSession("conn-dropped", "play-sess");

		expect(service.sendPlaybackCommand("play-sess", { type: "play" })).toBe(false);
		expect(service.getConnectedCount()).toBe(1);
	});
});

describe("RealtimeService limits", () => {
	test("refuses an eleventh playback-session subscription on one connection", () => {
		const player = recordingSocket();
		service.register({ connectionId: "conn-player", userId: "user-test", socket: player.socket });

		for (let index = 0; index < 10; index++) {
			expect(service.subscribeToPlaybackSession("conn-player", `play-${index}`)).toBe(true);
		}
		expect(service.subscribeToPlaybackSession("conn-player", "play-10")).toBe(false);
		expect(service.isSubscribedToPlaybackSession("conn-player", "play-10")).toBe(false);
	});

	test("refuses the thirty-third connection for one user", () => {
		const rejected = recordingSocket();
		for (let index = 0; index < 32; index++) {
			service.register({ connectionId: `conn-${index}`, userId: "user-capped", socket: recordingSocket().socket });
		}
		expect(service.getConnectedCount()).toBe(32);

		service.register({ connectionId: "conn-over", userId: "user-capped", socket: rejected.socket });

		expect(service.getConnectedCount()).toBe(32);
		expect(rejected.closes.map((close) => close.code)).toEqual([1013]);
	});

	test("refuses a connection after the global ceiling", () => {
		const rejected = recordingSocket();
		for (let index = 0; index < 10_000; index++) {
			service.register({ connectionId: `conn-${index}`, userId: `user-${index}`, socket: recordingSocket().socket });
		}
		expect(service.getConnectedCount()).toBe(10_000);

		service.register({ connectionId: "conn-over", userId: "user-over", socket: rejected.socket });

		expect(service.getConnectedCount()).toBe(10_000);
		expect(rejected.closes.map((close) => close.code)).toEqual([1013]);
	});
});

describe("RealtimeService session disconnect", () => {
	test("closing an auth session unregisters its sockets and reports how many closed", () => {
		const first = recordingSocket();
		const second = recordingSocket();
		const other = recordingSocket();
		service.register({ connectionId: "conn-1", userId: "user-1", sessionId: "auth-1", socket: first.socket });
		service.register({ connectionId: "conn-2", userId: "user-1", sessionId: "auth-1", socket: second.socket });
		service.register({ connectionId: "conn-3", userId: "user-1", sessionId: "auth-2", socket: other.socket });

		expect(service.disconnectAuthSession("auth-1")).toBe(2);

		expect(first.closes.map((close) => close.code)).toEqual([4001]);
		expect(second.closes.map((close) => close.code)).toEqual([4001]);
		expect(other.closes).toEqual([]);
		expect(service.getConnectedCount()).toBe(1);
	});
});

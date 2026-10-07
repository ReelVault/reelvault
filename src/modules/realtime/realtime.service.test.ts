import { describe, expect, it, mock } from "bun:test";
import { RealtimeService } from "./realtime.service";

describe("RealtimeService", () => {
	it("registers connections, handles targeted messaging and unregisters", () => {
		const service = new RealtimeService();

		const sendUser1 = mock();
		const sendUser2 = mock();

		service.register({
			connectionId: "conn-1",
			userId: "user-1",
			profileId: "profile-1",
			sessionId: "session-1",
			socket: { send: sendUser1 },
		});

		service.register({
			connectionId: "conn-2",
			userId: "user-2",
			profileId: "profile-2",
			sessionId: "session-2",
			socket: { send: sendUser2 },
		});

		expect(service.getConnectedCount()).toBe(2);

		// Send to user 1
		service.sendToUser("user-1", "library:scan:completed", { libraryId: "lib-1" });
		expect(sendUser1).toHaveBeenCalledTimes(1);
		expect(sendUser2).toHaveBeenCalledTimes(0);

		// Send to profile 2
		service.sendToProfile("profile-2", "notification:created", { id: "notif-1" });
		expect(sendUser2).toHaveBeenCalledTimes(1);

		// Broadcast
		service.broadcast("system:ping", {});
		expect(sendUser1).toHaveBeenCalledTimes(2);
		expect(sendUser2).toHaveBeenCalledTimes(2);

		const stats = service.getStats();
		expect(stats.totalConnections).toBe(2);
		expect(stats.uniqueUsers).toBe(2);
		expect(stats.uniqueProfiles).toBe(2);
		expect(stats.totalMessagesSent).toBeGreaterThanOrEqual(4);

		service.unregister("conn-1");
		service.unregister("conn-2");
		expect(service.getConnectedCount()).toBe(0);

		service.shutdown();
	});

	it("keeps slow clients registered on drops and closes them after repeated backpressure", () => {
		const service = new RealtimeService();
		const sendSocket = mock(() => -1);
		const closeSocket = mock();

		service.register({
			connectionId: "conn-slow",
			userId: "user-slow",
			profileId: "profile-slow",
			socket: { send: sendSocket, close: closeSocket },
		});

		// Four drops keep the connection registered — the buffer may still drain.
		for (let attempt = 0; attempt < 4; attempt++) service.broadcast("system:ping", {});
		expect(service.getConnectedCount()).toBe(1);
		expect(closeSocket).toHaveBeenCalledTimes(0);

		// The fifth consecutive drop closes it so the client reconnects and resyncs.
		service.broadcast("system:ping", {});
		expect(closeSocket).toHaveBeenCalledWith(1013, "Client too slow");
		expect(service.getConnectedCount()).toBe(0);

		// Dropped messages are never counted as delivered.
		expect(service.getStats().totalMessagesSent).toBe(0);

		service.shutdown();
	});

	it("resets the drop streak once a send succeeds", () => {
		const service = new RealtimeService();
		let sendResult: number | undefined = -1;
		const closeSocket = mock();

		service.register({
			connectionId: "conn-flaky",
			userId: "user-flaky",
			socket: { send: () => sendResult, close: closeSocket },
		});

		for (let attempt = 0; attempt < 4; attempt++) service.broadcast("system:ping", {});
		sendResult = 1; // buffer drained
		service.broadcast("system:ping", {});
		sendResult = -1;
		for (let attempt = 0; attempt < 4; attempt++) service.broadcast("system:ping", {});

		expect(closeSocket).toHaveBeenCalledTimes(0);
		expect(service.getConnectedCount()).toBe(1);
		expect(service.getStats().totalMessagesSent).toBe(1);

		service.shutdown();
	});

	it("manages dynamic playback session subscriptions and commands", () => {
		const service = new RealtimeService();
		const sendSocket = mock();

		service.register({
			connectionId: "conn-player",
			userId: "user-test",
			profileId: "profile-test",
			socket: { send: sendSocket },
		});

		expect(service.isSubscribedToPlaybackSession("conn-player", "play-sess-1")).toBe(false);
		expect(service.sendPlaybackCommand("play-sess-1", { type: "play" })).toBe(false);

		const subscribed = service.subscribeToPlaybackSession("conn-player", "play-sess-1");
		expect(subscribed).toBe(true);
		expect(service.isSubscribedToPlaybackSession("conn-player", "play-sess-1")).toBe(true);

		const delivered = service.sendPlaybackCommand("play-sess-1", { type: "seek", relative: -10 }, "remote-profile");
		expect(delivered).toBe(true);
		expect(sendSocket).toHaveBeenCalledTimes(1);

		const parsed = JSON.parse(String(sendSocket.mock.calls[0]?.[0]));
		expect(parsed.type).toBe("playback:command");
		expect(parsed.payload.command).toEqual({ type: "seek", relative: -10 });
		expect(parsed.payload.senderProfileId).toBe("remote-profile");

		service.unsubscribeFromPlaybackSession("conn-player", "play-sess-1");
		expect(service.isSubscribedToPlaybackSession("conn-player", "play-sess-1")).toBe(false);
		expect(service.sendPlaybackCommand("play-sess-1", { type: "pause" })).toBe(false);

		service.shutdown();
	});

	it("broadcasts worker progress only to admin connections", () => {
		const service = new RealtimeService();
		const sendAdmin = mock();
		const sendViewer = mock();

		service.register({ connectionId: "conn-admin", userId: "user-admin", isAdmin: true, socket: { send: sendAdmin } });
		service.register({ connectionId: "conn-viewer", userId: "user-viewer", socket: { send: sendViewer } });

		service.broadcastToAdmins("worker:progress", { jobId: "job-1", workerId: "library-scan", percent: 42 });

		expect(sendAdmin).toHaveBeenCalledTimes(1);
		expect(sendViewer).toHaveBeenCalledTimes(0);

		// A regular broadcast still reaches everyone.
		service.broadcast("system:ping", {});
		expect(sendAdmin).toHaveBeenCalledTimes(2);
		expect(sendViewer).toHaveBeenCalledTimes(1);

		service.shutdown();
	});
});

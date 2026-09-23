import { describe, expect, it, mock } from "bun:test";
import { RealtimeService } from "./index";

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
});

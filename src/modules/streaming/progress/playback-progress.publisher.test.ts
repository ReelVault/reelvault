import { describe, expect, test } from "bun:test";
import { PlaybackProgressPublisher, type PlaybackProgressUpdateEvent } from "./playback-progress.publisher";

function createDependencies() {
	const pluginEvents: Array<{ event: string; payload: unknown }> = [];
	const realtimeMessages: Array<{ profileId: string; event: string; payload: unknown }> = [];

	return {
		pluginEvents,
		realtimeMessages,
		dependencies: {
			pluginsService: {
				publish: (event: string, payload: unknown) => {
					pluginEvents.push({ event, payload });
				},
			},
			realtimeService: {
				sendToProfile: (profileId: string, event: string, payload: unknown) => {
					realtimeMessages.push({ profileId, event, payload });
				},
			},
		},
	};
}

const baseEvent: PlaybackProgressUpdateEvent = {
	profileId: "profile-1",
	mediaFileId: "file-1",
	position: 540,
	duration: 600,
	completed: true,
	audioStreamIndex: 1,
	subtitleId: "sub-7",
};

describe("playback progress publisher", () => {
	test("publishes plugin, lifecycle and realtime events for one update", () => {
		const { pluginEvents, realtimeMessages, dependencies } = createDependencies();
		const publisher = new PlaybackProgressPublisher(dependencies);

		publisher.publishUpdate(baseEvent);

		expect(pluginEvents).toHaveLength(2);
		expect(pluginEvents[0]).toMatchObject({
			event: "playback.progress.updated",
			payload: {
				profileId: "profile-1",
				mediaFileId: "file-1",
				position: 540,
				duration: 600,
				completed: true,
				audioStreamIndex: 1,
				subtitleId: "sub-7",
			},
		});
		expect(pluginEvents[1]?.event).toBe("playback.lifecycle.progress");
		expect(pluginEvents[1]?.payload).toMatchObject({ progressPercent: 90 });
		const lifecyclePayload = pluginEvents[1]?.payload as { updatedAt: string } | undefined;
		expect(typeof lifecyclePayload?.updatedAt).toBe("string");

		expect(realtimeMessages).toEqual([
			{
				profileId: "profile-1",
				event: "playback:progress:updated",
				payload: {
					mediaFileId: "file-1",
					position: 540,
					duration: 600,
					completed: true,
					audioStreamIndex: 1,
					subtitleId: "sub-7",
				},
			},
		]);
	});

	test("computes progressPercent as 0 when duration is 0", () => {
		const { pluginEvents, dependencies } = createDependencies();
		const publisher = new PlaybackProgressPublisher(dependencies);

		publisher.publishUpdate({ ...baseEvent, position: 30, duration: 0 });

		expect(pluginEvents[1]?.payload).toMatchObject({ progressPercent: 0 });
	});
});

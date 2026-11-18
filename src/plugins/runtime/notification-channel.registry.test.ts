import { afterEach, describe, expect, test } from "bun:test";
import type { OutgoingNotification, PluginNotificationChannel } from "@reelvault/sdk/plugin";
import { waitFor } from "../../../tests/helpers/wait.helper";
import { dispatchNotificationToChannels, onNotificationChannelFailure, registerNotificationChannel } from "./notification-channel.registry";

function channel(id: string, calls: OutgoingNotification[], failure?: Error) {
	return {
		id,
		deliver: (notification: OutgoingNotification) => {
			calls.push(notification);
			if (failure) return Promise.reject(failure);

			return Promise.resolve();
		},
	};
}

const sample = { id: "n-1", userId: "u-1", type: "test", title: "Hello" } as const;

/** The registry is process-wide: keep every unsubscribe so one test cannot leak channels into the next. */
const unsubscribers: Array<() => void> = [];

function registerChannel(pluginId: string, pluginChannel: PluginNotificationChannel): () => void {
	const unsubscribe = registerNotificationChannel(pluginId, pluginChannel);
	unsubscribers.push(unsubscribe);

	return unsubscribe;
}

afterEach(() => {
	for (const unsubscribe of unsubscribers.splice(0).toReversed()) unsubscribe();
});

describe("notification channel registry", () => {
	test("dispatches to every registered channel with an isolated payload", async () => {
		const seen: OutgoingNotification[] = [];
		registerChannel("plugin-a", {
			id: "mutator",
			deliver: (notification) => {
				notification.title = "Changed by a channel";

				return Promise.resolve();
			},
		});
		registerChannel("plugin-b", channel("c1", seen));

		await dispatchNotificationToChannels({ ...sample });

		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe("n-1");
		expect(seen[0]?.title).toBe("Hello");
	});

	test("one failing channel does not block the others", async () => {
		const okSeen: OutgoingNotification[] = [];
		const failing: OutgoingNotification[] = [];
		registerChannel("plugin-a", channel("broken", failing, new Error("network down")));
		registerChannel("plugin-b", channel("working", okSeen));

		await dispatchNotificationToChannels({ ...sample });

		expect(failing).toHaveLength(1);
		expect(okSeen).toHaveLength(1);
	});

	test("unsubscribing a plugin's channels leaves other plugins delivering", async () => {
		const seen: OutgoingNotification[] = [];
		const stopFirst = registerChannel("plugin-a", channel("c1", seen));
		const stopSecond = registerChannel("plugin-a", channel("c2", seen));
		registerChannel("plugin-b", channel("c3", seen));

		stopFirst();
		stopSecond();
		await dispatchNotificationToChannels({ ...sample });

		expect(seen).toHaveLength(1);
	});

	test("a slow channel does not hold up the channels after it", async () => {
		const order: string[] = [];
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const slow = {
			id: "slow",
			deliver: async () => {
				await slowGate;
				order.push("slow");
			},
		};
		const fast = {
			id: "fast",
			deliver: () => {
				order.push("fast");

				return Promise.resolve();
			},
		};
		registerChannel("plugin-slow", slow);
		registerChannel("plugin-fast", fast);

		const dispatched = dispatchNotificationToChannels({ ...sample });
		// Dispatch must reach the fast channel and let it finish while the slow one is still held.
		await waitFor(() => order.includes("fast"));
		expect(order).toEqual(["fast"]);

		releaseSlow();
		await dispatched;
		expect(order).toEqual(["fast", "slow"]);
	});
});

describe("notification channel failure reporting", () => {
	test("rejects a duplicate channel id instead of silently overwriting it", () => {
		const seen: OutgoingNotification[] = [];
		registerChannel("plugin-a", channel("c1", seen));

		expect(() => registerChannel("plugin-a", channel("c1", seen))).toThrow(
			expect.objectContaining({
				category: "conflict",
				code: "plugin.notification_channel.duplicate",
				params: { pluginId: "plugin-a", channelId: "c1" },
			}),
		);
	});

	test("reports a channel once per failing streak and again after it recovers", async () => {
		let healthy = false;
		const flaky = {
			id: "webhook",
			deliver: () => (healthy ? Promise.resolve() : Promise.reject(new Error("503 from endpoint"))),
		};
		registerChannel("plugin-streak", flaky);
		const reports: Array<{ pluginId: string; channelId: string }> = [];
		const stop = onNotificationChannelFailure((failure) => reports.push({ pluginId: failure.pluginId, channelId: failure.channelId }));

		try {
			await dispatchNotificationToChannels(sample);
			await dispatchNotificationToChannels(sample);
			expect(reports).toEqual([{ pluginId: "plugin-streak", channelId: "webhook" }]);

			healthy = true;
			await dispatchNotificationToChannels(sample);
			expect(reports).toHaveLength(1);

			healthy = false;
			await dispatchNotificationToChannels(sample);
			expect(reports).toHaveLength(2);
		} finally {
			stop();
		}
	});

	test("removing a failure listener stops later failure reports", async () => {
		const reports: Array<{ pluginId: string; channelId: string }> = [];
		const stop = onNotificationChannelFailure((failure) => reports.push({ pluginId: failure.pluginId, channelId: failure.channelId }));
		registerChannel("plugin-listener-cleanup", channel("cleanup", [], new Error("endpoint down")));

		try {
			stop();
			await dispatchNotificationToChannels({ ...sample });
			expect(reports).toEqual([]);
		} finally {
			stop();
		}
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import type { OutgoingNotification } from "@reelvault/sdk/plugin";
import { waitFor } from "../../../tests/helpers/wait.helper";
import {
	dispatchNotificationToChannels,
	onNotificationChannelFailure,
	registerNotificationChannel,
	unregisterPluginNotificationChannels,
} from "./notification-channel.registry";

const PLUGIN_IDS = ["plugin-a", "plugin-b", "plugin-slow", "plugin-fast", "plugin-streak"];

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

afterEach(() => {
	// The channel registry is process-wide, so a failed test must not leave a channel behind.
	for (const pluginId of PLUGIN_IDS) unregisterPluginNotificationChannels(pluginId);
});

describe("notification channel registry", () => {
	test("dispatches to every registered channel with an isolated payload", async () => {
		const seen: OutgoingNotification[] = [];
		registerNotificationChannel("plugin-a", {
			id: "mutator",
			deliver: (notification) => {
				notification.title = "Changed by a channel";

				return Promise.resolve();
			},
		});
		registerNotificationChannel("plugin-b", channel("c1", seen));

		await dispatchNotificationToChannels({ ...sample });

		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe("n-1");
		expect(seen[0]?.title).toBe("Hello");
	});

	test("one failing channel does not block the others", async () => {
		const okSeen: OutgoingNotification[] = [];
		const failing: OutgoingNotification[] = [];
		registerNotificationChannel("plugin-a", channel("broken", failing, new Error("network down")));
		registerNotificationChannel("plugin-b", channel("working", okSeen));

		await dispatchNotificationToChannels({ ...sample });

		expect(failing).toHaveLength(1);
		expect(okSeen).toHaveLength(1);
	});

	test("unregister by plugin removes all of its channels", async () => {
		const seen: OutgoingNotification[] = [];
		registerNotificationChannel("plugin-a", channel("c1", seen));
		registerNotificationChannel("plugin-a", channel("c2", seen));
		registerNotificationChannel("plugin-b", channel("c3", seen));

		unregisterPluginNotificationChannels("plugin-a");
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
		registerNotificationChannel("plugin-slow", slow);
		registerNotificationChannel("plugin-fast", fast);

		const dispatched = dispatchNotificationToChannels({ ...sample });
		// Dispatch must reach the fast channel and let it finish while the slow one is still held.
		await waitFor(() => order.includes("fast"));
		expect(order).toEqual(["fast"]);

		releaseSlow();
		await dispatched;
		expect(order).toEqual(["fast", "slow"]);
	});

	test("rejects a duplicate channel id instead of silently overwriting it", () => {
		const seen: OutgoingNotification[] = [];
		registerNotificationChannel("plugin-a", channel("c1", seen));

		expect(() => registerNotificationChannel("plugin-a", channel("c1", seen))).toThrow(
			expect.objectContaining({ category: "conflict", code: "plugin.notification_channel.duplicate" }),
		);
	});

	test("reports a channel once per failing streak and again after it recovers", async () => {
		let healthy = false;
		const flaky = {
			id: "webhook",
			deliver: () => (healthy ? Promise.resolve() : Promise.reject(new Error("503 from endpoint"))),
		};
		registerNotificationChannel("plugin-streak", flaky);
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
});

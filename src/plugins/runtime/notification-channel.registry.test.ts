import { describe, expect, test } from "bun:test";
import type { OutgoingNotification } from "@reelvault/sdk/plugin";
import {
	dispatchNotificationToChannels,
	registerNotificationChannel,
	unregisterPluginNotificationChannels,
} from "./notification-channel.registry";

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

describe("notification channel registry", () => {
	test("dispatches to every registered channel with an isolated payload", async () => {
		const seen: OutgoingNotification[] = [];
		const unregister = registerNotificationChannel("plugin-a", channel("c1", seen));

		await dispatchNotificationToChannels({ ...sample });

		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe("n-1");
		unregister();
	});

	test("one failing channel does not block the others", async () => {
		const okSeen: OutgoingNotification[] = [];
		const failing: OutgoingNotification[] = [];
		const cleanups = [
			registerNotificationChannel("plugin-a", channel("broken", failing, new Error("network down"))),
			registerNotificationChannel("plugin-b", channel("working", okSeen)),
		];

		await dispatchNotificationToChannels({ ...sample });

		expect(failing).toHaveLength(1);
		expect(okSeen).toHaveLength(1);
		for (const cleanup of cleanups) cleanup();
	});

	test("unregister by plugin removes all of its channels", async () => {
		const seen: OutgoingNotification[] = [];
		registerNotificationChannel("plugin-a", channel("c1", seen));
		registerNotificationChannel("plugin-a", channel("c2", seen));
		registerNotificationChannel("plugin-b", channel("c3", seen));

		unregisterPluginNotificationChannels("plugin-a");
		await dispatchNotificationToChannels({ ...sample });

		expect(seen).toHaveLength(1);
		unregisterPluginNotificationChannels("plugin-b");
	});

	test("a slow channel does not hold up the channels after it", async () => {
		const order: string[] = [];
		const slow = {
			id: "slow",
			deliver: async () => {
				await Bun.sleep(50);
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
		const unregisterSlow = registerNotificationChannel("plugin-slow", slow);
		const unregisterFast = registerNotificationChannel("plugin-fast", fast);

		await dispatchNotificationToChannels({ ...sample });

		expect(order).toEqual(["fast", "slow"]);
		unregisterSlow();
		unregisterFast();
	});

	test("rejects a duplicate channel id instead of silently overwriting it", () => {
		const seen: OutgoingNotification[] = [];
		const unregister = registerNotificationChannel("plugin-a", channel("c1", seen));

		expect(() => registerNotificationChannel("plugin-a", channel("c1", seen))).toThrow("already registered");
		unregister();
	});
});

import { expect, test } from "bun:test";
import { NotificationsClient, ReelVaultClient } from "@sdk/client";

test("notifications client reads and updates the current recipient inbox", async () => {
	const requests: string[] = [];
	const client = new ReelVaultClient({
		baseUrl: "https://reelvault.test/v1",
		enableRetry: false,
		fetcher: (url, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(url)}`);
			if (String(url).endsWith("unread-count")) return Promise.resolve(json({ count: 2 }));

			if (init?.method === "GET") return Promise.resolve(json([]));

			return Promise.resolve(json({ success: true }));
		},
	});

	expect(client.notifications).toBeInstanceOf(NotificationsClient);
	await expect(client.notifications.getAll({ unreadOnly: true })).resolves.toEqual([]);
	await expect(client.notifications.getUnreadCount()).resolves.toEqual({ count: 2 });
	await expect(client.notifications.markRead("notification-1")).resolves.toEqual({ success: true });
	await expect(client.notifications.markAllRead()).resolves.toEqual({ success: true });
	expect(requests).toEqual([
		"GET https://reelvault.test/v1/notifications?unreadOnly=true",
		"GET https://reelvault.test/v1/notifications/unread-count",
		"PATCH https://reelvault.test/v1/notifications/notification-1",
		"PATCH https://reelvault.test/v1/notifications",
	]);
});

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

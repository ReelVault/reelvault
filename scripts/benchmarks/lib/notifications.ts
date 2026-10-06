import { isRecord } from "@/utils/type.utils";
import { workerCookie } from "./identity";
import type { ManagedServer } from "./server";

/**
 * Lists a worker identity's unread notification ids. Seeded notifications
 * belong to the per-worker identities, not the admin — list them as their
 * owner, and only unread ones: re-marking a read row is 403.
 */
export async function preloadUnreadNotificationIds(server: ManagedServer, workerIndex: number, forwardedFor: string): Promise<string[]> {
	const response = await fetch(`${server.baseUrl}/v1/notifications?unreadOnly=true&limit=50`, {
		headers: {
			cookie: workerCookie(server, workerIndex),
			"x-profile-id": server.profileIdFor(workerIndex),
			"x-forwarded-for": forwardedFor,
		},
	});
	if (!response.ok) return [];

	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) return [];

	return payload.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
}

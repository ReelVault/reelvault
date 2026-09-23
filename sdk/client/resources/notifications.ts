import type { Notification } from "@sdk/common/notification.types";
import { BaseResource } from "../core/base-resource";

export class NotificationsClient extends BaseResource {
	getAll(query: { unreadOnly?: boolean } = {}): Promise<Notification[]> {
		return this._get("/notifications", { query });
	}

	getUnreadCount(): Promise<{ count: number }> {
		return this._get("/notifications/unread-count");
	}

	markRead(id: string): Promise<{ success: true }> {
		return this._patch(`/notifications/${id}`, { body: { read: true } });
	}

	markAllRead(): Promise<{ success: true }> {
		return this._patch("/notifications", { body: { all: true } });
	}
}

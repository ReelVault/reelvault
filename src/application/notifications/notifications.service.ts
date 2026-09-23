import type { CreateNotification, Notification } from "@sdk/common/notification.types";
import { invalidateProfileResponseBodies } from "@/api/utils/etag.utils";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { playbackRepository } from "@/database/repositories/playback.repository";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { realtimeService } from "@/modules/realtime";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";

// Clients poll unread-count on an interval; a short TTL absorbs the poll storm
// and every mutation below invalidates eagerly, so badge updates stay immediate.
const UNREAD_COUNT_CACHE_TTL_MS = 5_000;
const UNREAD_COUNT_CACHE_MAX = 2_000;
const unreadCountCache = new MemoryCache<number>({
	ttlMs: UNREAD_COUNT_CACHE_TTL_MS,
	maxSize: UNREAD_COUNT_CACHE_MAX,
	name: "notifications.unreadCount",
});

function unreadCountKey(userId: string, profileId?: string): string {
	return profileId ? `${userId}:${profileId}` : userId;
}

class NotificationsService extends BaseService {
	constructor() {
		super("NotificationsService");
	}

	async create(
		notification: CreateNotification,
		options?: { skipOwnershipCheck?: boolean; sourcePluginId?: string | undefined },
	): Promise<string> {
		return await this.safeExecute("create", async () => {
			if (!options?.skipOwnershipCheck) {
				await this.assertProfileBelongsToUser(notification.userId, notification.profileId);
			}

			const sourcePluginId = options?.sourcePluginId ?? null;
			if (sourcePluginId) {
				// Per-plugin flood guard: throw (instead of silently dropping) so the
				// plugin learns its notifications are not being delivered.
				const startOfDay = new Date();
				startOfDay.setHours(0, 0, 0, 0);
				const createdToday = await notificationsRepository.countCreatedByPluginSince(sourcePluginId, startOfDay);
				const maxPerDay = serverConfig.plugins.notifications.maxPerDayPerPlugin;
				if (createdToday >= maxPerDay) {
					throw new ValidationError(`Plugin '${sourcePluginId}' exceeded the daily notification limit (${maxPerDay})`, {
						code: "plugin.notifications.rate_limited",
					});
				}
			}

			const id = await notificationsRepository.create({
				userId: notification.userId,
				profileId: notification.profileId ?? null,
				type: notification.type,
				title: notification.title,
				message: notification.message ?? null,
				data: notification.data ?? {},
				link: notification.link ?? null,
				sourcePluginId,
			});
			unreadCountCache.delete(unreadCountKey(notification.userId, notification.profileId ?? undefined));
			pluginEventBus.publish("notification.created", {
				notificationId: id,
				userId: notification.userId,
				profileId: notification.profileId,
				type: notification.type,
				sourcePluginId,
			});
			const realtimePayload = {
				id,
				userId: notification.userId,
				profileId: notification.profileId,
				type: notification.type,
				title: notification.title,
				message: notification.message ?? null,
				link: notification.link ?? null,
			};
			if (notification.profileId) {
				realtimeService.sendToProfile(notification.profileId, "notification:created", realtimePayload);
			} else {
				realtimeService.sendToUser(notification.userId, "notification:created", realtimePayload);
			}

			return id;
		});
	}

	async getAll(userId?: string, profileId?: string, unreadOnly = false, limit?: number): Promise<Notification[]> {
		return await this.safeExecute("getAll", async () => {
			this.assertUserId(userId);

			// `limit` is optional — when omitted the repository default applies (behavior unchanged).
			return await notificationsRepository.findForRecipient(userId, profileId, unreadOnly, limit);
		});
	}

	async getUnreadCount(userId?: string, profileId?: string): Promise<{ count: number }> {
		return await this.safeExecute("getUnreadCount", async () => {
			this.assertUserId(userId);
			const key = unreadCountKey(userId, profileId);
			const count = await unreadCountCache.getOrSet(key, () => notificationsRepository.countUnread(userId, profileId));

			return { count };
		});
	}

	async markRead(id: string, userId?: string, profileId?: string): Promise<{ success: true }> {
		return await this.safeExecute("markRead", async () => {
			this.assertUserId(userId);
			const marked = await notificationsRepository.markReadForRecipient(id, userId, profileId);
			if (!marked) {
				throw new ForbiddenError("Notification is not available to this account or profile");
			}

			unreadCountCache.delete(unreadCountKey(userId, profileId));
			if (profileId) invalidateProfileResponseBodies(profileId);

			return { success: true };
		});
	}

	async markAllRead(userId?: string, profileId?: string): Promise<{ success: true }> {
		return await this.safeExecute("markAllRead", async () => {
			this.assertUserId(userId);
			await notificationsRepository.markAllReadForRecipient(userId, profileId);
			unreadCountCache.delete(unreadCountKey(userId, profileId));
			if (profileId) invalidateProfileResponseBodies(profileId);

			return { success: true };
		});
	}

	async updateStatus(
		params: { ids?: string[]; all?: boolean; read?: boolean },
		userId?: string,
		profileId?: string,
	): Promise<{ success: true }> {
		return await this.safeExecute("updateStatus", async () => {
			this.assertUserId(userId);
			if (params.all) {
				await notificationsRepository.markAllReadForRecipient(userId, profileId);
				unreadCountCache.delete(unreadCountKey(userId, profileId));
				if (profileId) invalidateProfileResponseBodies(profileId);

				return { success: true as const };
			}

			if (params.ids && params.ids.length > 0) {
				await notificationsRepository.markReadBatch(params.ids, userId, profileId);
				unreadCountCache.delete(unreadCountKey(userId, profileId));
				if (profileId) invalidateProfileResponseBodies(profileId);
			}

			return { success: true as const };
		});
	}

	async notifyNewEpisode(input: {
		metadataId: string;
		showTitle: string;
		seasonNumber: number;
		episodeNumber: number;
		episodeTitle?: string | undefined;
	}): Promise<void> {
		await this.safeExecute("notifyNewEpisode", async () => {
			const [viewers, watchlistUsers] = await Promise.all([
				playbackRepository.findViewerProfilesByMetadataId(input.metadataId),
				watchlistRepository.findProfilesByMetadataId(input.metadataId),
			]);

			const recipients = new Map<string, { userId: string; profileId: string }>();
			for (const item of [...viewers, ...watchlistUsers]) {
				if (item.profileId && item.userId && !recipients.has(item.profileId)) {
					recipients.set(item.profileId, { userId: item.userId, profileId: item.profileId });
				}
			}

			if (recipients.size > 0) {
				const now = new Date();
				const items = [...recipients.values()].map((recipient) => ({
					userId: recipient.userId,
					profileId: recipient.profileId,
					type: "new_episode" as const,
					// Text is rendered by the frontend from `type` + `data`; the server
					// persists only a stable key and the interpolation values.
					title: "notification.new_episode",
					message: null,
					link: `/details/${input.metadataId}`,
					data: {
						metadataId: input.metadataId,
						seasonNumber: input.seasonNumber,
						episodeNumber: input.episodeNumber,
						showTitle: input.showTitle,
						episodeTitle: input.episodeTitle ?? null,
					},
					createdAt: now,
					updatedAt: now,
				}));
				const recipientList = [...recipients.values()];
				const ids = await notificationsRepository.createBatch(items);
				for (const recipient of recipientList) {
					unreadCountCache.delete(unreadCountKey(recipient.userId, recipient.profileId));
				}

				for (let i = 0; i < ids.length; i++) {
					const recipient = recipientList[i];
					const notifId = ids[i];
					if (!(recipient && notifId)) continue;

					pluginEventBus.publish("notification.created", {
						notificationId: notifId,
						userId: recipient.userId,
						profileId: recipient.profileId,
						type: "new_episode",
					});
				}
			}
		});
	}

	private async assertProfileBelongsToUser(userId: string, profileId?: string): Promise<void> {
		if (!profileId) return;

		const profile = await profilesRepository.findByUserAndId(userId, profileId);
		if (!profile) {
			throw new ForbiddenError("Notification profile does not belong to the user");
		}
	}
}

export const notificationsService = new NotificationsService();

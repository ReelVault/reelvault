import type { CreateNotification, Notification, PaginatedResponse } from "@reelvault/sdk/common";
import { notificationsRepository } from "@/database/repositories/notifications.repository";
import { playbackRepository } from "@/database/repositories/playback.repository";
import { profilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { realtimeService } from "@/modules/realtime/realtime.service";
import {
	dispatchNotificationToChannels,
	type NotificationChannelFailure,
	onNotificationChannelFailure,
} from "@/plugins/runtime/notification-channel.registry";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { serverConfig } from "@/server.config";
import { assertUserId, DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { MemoryCache } from "@/utils/memory-cache";
import { detach } from "@/utils/promise.utils";
import { invalidateProfileResponseBodies, invalidateResponseBodies } from "@/utils/response-body-cache";
import { runSafely } from "@/utils/safe-execute";
import { parseMutedNotificationTypes } from "./notification-mute.utils";

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

class NotificationsService {
	readonly serviceName = "NotificationsService";
	readonly logger = createLogger("NotificationsService");

	async create(
		notification: CreateNotification,
		options?: { skipOwnershipCheck?: boolean; sourcePluginId?: string | undefined },
	): Promise<string> {
		return await runSafely(this, "create", async () => {
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
					throw new DomainError("validation", `Plugin '${sourcePluginId}' exceeded the daily notification limit (${maxPerDay})`, {
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
			this.invalidateFor(notification.userId, notification.profileId ?? undefined);
			const outgoing = {
				id,
				userId: notification.userId,
				profileId: notification.profileId,
				type: notification.type,
				title: notification.title,
				message: notification.message ?? null,
				data: notification.data ?? {},
				link: notification.link ?? null,
			};
			this.emitNotificationCreated({ ...outgoing, sourcePluginId });
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
				// A muted type still exists for the profile's list and plugins; it just does not interrupt with a live event.
				const muted = await this.mutedTypesFor(notification.profileId);
				if (!muted.includes(notification.type)) {
					realtimeService.sendToProfile(notification.profileId, "notification:created", realtimePayload);
				}
			} else {
				realtimeService.sendToUser(notification.userId, "notification:created", realtimePayload);
			}

			return id;
		});
	}

	/** Notification types the profile has muted; none without a profile. */
	private async mutedTypesFor(profileId?: string): Promise<string[]> {
		if (!profileId) return [];

		const preferences = await profilePreferencesRepository.getEffective({ profileId });

		return parseMutedNotificationTypes(preferences.mutedNotificationTypes);
	}

	async getAll(userId?: string, profileId?: string, unreadOnly = false, limit?: number): Promise<Notification[]> {
		return await runSafely(this, "getAll", async () => {
			assertUserId(userId);

			// `limit` is optional — when omitted the repository default applies (behavior unchanged).
			return await notificationsRepository.findForRecipient(userId, profileId, unreadOnly, limit, await this.mutedTypesFor(profileId));
		});
	}

	/** One page of notifications, filtered by read state and type; the total counts the same filter. */
	async getPage(
		query: { page?: number | undefined; limit?: number | undefined; unreadOnly?: boolean | undefined; type?: string | undefined },
		userId?: string,
		profileId?: string,
	): Promise<PaginatedResponse<Notification>> {
		return await runSafely(this, "getPage", async () => {
			assertUserId(userId);
			const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 25, maxLimit: 100 });
			const result = await notificationsRepository.findPageForRecipient({
				userId,
				profileId,
				unreadOnly: query.unreadOnly ?? false,
				type: query.type,
				excludedTypes: await this.mutedTypesFor(profileId),
				limit: pagination.limit,
				offset: pagination.offset,
			});

			return QueryPagination.createResponse({ total: result.total, pagination, data: result.data });
		});
	}

	async getUnreadCount(userId?: string, profileId?: string): Promise<{ count: number }> {
		return await runSafely(this, "getUnreadCount", async () => {
			assertUserId(userId);
			const key = unreadCountKey(userId, profileId);
			const excludedTypes = await this.mutedTypesFor(profileId);
			// The cache keys the recipient only, so a profile with muted types is counted live.
			const count =
				excludedTypes.length > 0
					? await notificationsRepository.countUnread(userId, profileId, excludedTypes)
					: await unreadCountCache.getOrSet(key, () => notificationsRepository.countUnread(userId, profileId));

			return { count };
		});
	}

	async markRead(id: string, userId?: string, profileId?: string, read = true): Promise<{ success: true }> {
		return await runSafely(this, "markRead", async () => {
			assertUserId(userId);
			const updated = read
				? await notificationsRepository.markReadForRecipient(id, userId, profileId)
				: await notificationsRepository.markUnreadForRecipient(id, userId, profileId);
			if (!updated) {
				throw new DomainError("forbidden", "Notification is not available to this account or profile", {
					code: "notification.access_denied",
					params: { notificationId: id },
				});
			}

			this.invalidateFor(userId, profileId);

			return { success: true };
		});
	}

	async markAllRead(userId?: string, profileId?: string): Promise<{ success: true }> {
		return await runSafely(this, "markAllRead", async () => {
			assertUserId(userId);
			await notificationsRepository.markAllReadForRecipient(userId, profileId);
			this.invalidateFor(userId, profileId);

			return { success: true };
		});
	}

	/**
	 * Batch status change. `read` selects the direction (defaults to read) and
	 * applies to both `all` and `ids` — previously the flag was ignored, so a
	 * client asking to mark notifications unread marked them read instead.
	 */
	async updateStatus(
		params: { ids?: string[]; all?: boolean; read?: boolean; type?: string },
		userId?: string,
		profileId?: string,
	): Promise<{ success: true }> {
		return await runSafely(this, "updateStatus", async () => {
			assertUserId(userId);
			const read = params.read ?? true;

			if (params.all) {
				await (read
					? notificationsRepository.markAllReadForRecipient(userId, profileId, params.type)
					: notificationsRepository.markAllUnreadForRecipient(userId, profileId, params.type));
			} else if (params.ids && params.ids.length > 0) {
				await (read
					? notificationsRepository.markReadBatch(params.ids, userId, profileId)
					: notificationsRepository.markUnreadBatch(params.ids, userId, profileId));
			}

			this.invalidateFor(userId, profileId);

			return { success: true as const };
		});
	}

	/** Removes notifications from the caller's own list; ids that belong to another recipient are ignored. */
	async deleteNotifications(ids: string[], userId?: string, profileId?: string): Promise<{ deleted: number }> {
		return await runSafely(this, "deleteNotifications", async () => {
			assertUserId(userId);
			const deleted = await notificationsRepository.deleteBatchForRecipient(ids, userId, profileId);
			this.invalidateFor(userId, profileId);

			return { deleted };
		});
	}

	/** Drops the unread-count entry and any cached notification bodies for the recipient. */
	private invalidateFor(userId: string, profileId?: string): void {
		unreadCountCache.delete(unreadCountKey(userId, profileId));
		// Account-scoped notifications also have a cached GET /notifications body; a
		// profile-scoped invalidation cannot reach it (its key carries no profile).
		if (profileId) invalidateProfileResponseBodies(profileId);
		else invalidateResponseBodies();
	}

	async notifyNewEpisode(input: {
		metadataId: string;
		showTitle: string;
		seasonNumber: number;
		episodeNumber: number;
		episodeTitle?: string | undefined;
	}): Promise<void> {
		await runSafely(this, "notifyNewEpisode", async () => {
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
					this.invalidateFor(recipient.userId, recipient.profileId);
				}

				for (let i = 0; i < ids.length; i++) {
					const recipient = recipientList[i];
					const notifId = ids[i];
					if (!(recipient && notifId)) continue;

					this.emitNotificationCreated({
						id: notifId,
						userId: recipient.userId,
						profileId: recipient.profileId,
						type: "new_episode",
						title: items[i]?.title ?? "notification.new_episode",
						message: null,
						link: `/details/${input.metadataId}`,
						data: items[i]?.data ?? {},
					});
				}
			}
		});
	}

	/**
	 * Publishes a created notification to plugin listeners and external delivery
	 * channels. Realtime delivery stays with each caller — the batch
	 * new-episode path predates it.
	 */
	private emitNotificationCreated(notification: {
		id: string;
		userId: string;
		profileId?: string | undefined;
		type: string;
		title: string;
		message: string | null;
		link: string | null;
		data: Record<string, unknown>;
		sourcePluginId?: string | null | undefined;
	}): void {
		pluginEventBus.publish("notification.created", {
			notificationId: notification.id,
			userId: notification.userId,
			profileId: notification.profileId,
			type: notification.type,
			title: notification.title,
			message: notification.message,
			link: notification.link,
			data: notification.data,
			...(notification.sourcePluginId !== undefined ? { sourcePluginId: notification.sourcePluginId } : {}),
		});

		// External channels are best-effort: delivery runs detached so a slow
		// webhook never delays the API response (registry contains per-channel
		// error isolation).
		detach(
			dispatchNotificationToChannels({
				id: notification.id,
				userId: notification.userId,
				profileId: notification.profileId,
				type: notification.type,
				title: notification.title,
				message: notification.message,
				link: notification.link,
				data: notification.data,
			}),
		);
	}

	private async assertProfileBelongsToUser(userId: string, profileId?: string): Promise<void> {
		if (!profileId) return;

		const profile = await profilesRepository.findByUserAndId(userId, profileId);
		if (!profile) {
			throw new DomainError("forbidden", "Notification profile does not belong to the user", {
				code: "profile.not_owned",
				params: { profileId, userId },
			});
		}
	}
	/** Host-generated (no plugin attribution), so the report does not count against the plugin's daily limit. */
	async notifyAdministratorsOfChannelFailure(failure: NotificationChannelFailure): Promise<void> {
		await this.createForAdministrators({
			type: "notification_channel_failed",
			title: `Notification channel ${failure.channelId} of ${failure.pluginId} stopped delivering`,
			message: failure.message,
			data: { pluginId: failure.pluginId, channelId: failure.channelId },
		});
	}

	/**
	 * Sends the same notification to every administrator. A recipient that fails does not stop the others; the
	 * first failure is rethrown once every administrator has been tried.
	 */
	async createForAdministrators(
		notification: Omit<CreateNotification, "userId" | "profileId">,
		options?: { sourcePluginId?: string | undefined },
	): Promise<void> {
		const admins = await usersRepository.findAllAdministrators();
		let firstFailure: Error | undefined;
		for (const admin of admins) {
			try {
				await this.create({ ...notification, userId: admin.id }, options);
			} catch (error) {
				firstFailure ??= error instanceof Error ? error : new Error(String(error));
			}
		}
		if (firstFailure) throw firstFailure;
	}
}

export const notificationsService = new NotificationsService();

// A channel that stops delivering tells the administrators once, with its error.
onNotificationChannelFailure((failure) => {
	detach(notificationsService.notifyAdministratorsOfChannelFailure(failure));
});

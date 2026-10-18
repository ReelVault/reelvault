import type { OutgoingNotification, PluginNotificationChannel } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { PromiseUtils } from "@/utils/promise.utils";

const logger = createLogger("NotificationChannels");

const channels = new Map<string, { pluginId: string; channel: PluginNotificationChannel }>();

export interface NotificationChannelFailure {
	pluginId: string;
	channelId: string;
	message: string;
}

type NotificationChannelFailureListener = (failure: NotificationChannelFailure) => void;

const failureListeners = new Set<NotificationChannelFailureListener>();
/** Channels whose last delivery failed. A failure is reported once per failing streak, so a channel that keeps failing stays quiet. */
const failingChannels = new Set<string>();

/** Hears about a channel that starts failing. Returns a function that stops listening. */
export function onNotificationChannelFailure(listener: NotificationChannelFailureListener): () => void {
	failureListeners.add(listener);

	return () => failureListeners.delete(listener);
}

/** Returns an unregister function — scopes push it onto their unsubscribe stack. */
export function registerNotificationChannel(pluginId: string, channel: PluginNotificationChannel): () => void {
	const key = `${pluginId}:${channel.id}`;
	if (channels.has(key)) {
		throw new DomainError("conflict", `Notification channel '${channel.id}' is already registered`, {
			code: "plugin.notification_channel.duplicate",
			params: { pluginId, channelId: channel.id },
		});
	}

	channels.set(key, { pluginId, channel });

	return () => {
		channels.delete(key);
		failingChannels.delete(key);
	};
}

export function unregisterPluginNotificationChannels(pluginId: string): void {
	for (const [key, entry] of channels) {
		if (entry.pluginId !== pluginId) continue;

		channels.delete(key);
		failingChannels.delete(key);
	}
}

function reportChannelFailure(key: string, entry: { pluginId: string; channel: PluginNotificationChannel }, error: unknown): void {
	if (failingChannels.has(key)) return;

	failingChannels.add(key);
	const failure: NotificationChannelFailure = {
		pluginId: entry.pluginId,
		channelId: entry.channel.id,
		message: error instanceof Error ? error.message : String(error),
	};
	for (const listener of failureListeners) listener(failure);
}

/**
 * Best-effort fan-out to every registered external channel. One failing channel
 * never blocks or fails the notification itself — delivery is detached by the
 * caller and every channel error is contained here with attribution.
 */
export async function dispatchNotificationToChannels(notification: OutgoingNotification): Promise<void> {
	if (channels.size === 0) return;

	// Channels deliver in parallel, each under its own time limit: a slow endpoint neither
	// holds up the channels after it nor keeps the dispatch open.
	await Promise.all(
		[...channels].map(async ([key, entry]) => {
			try {
				await PromiseUtils.withTimeout(
					entry.channel.deliver(structuredClone(notification)),
					serverConfig.plugins.notifications.channelDeliveryTimeoutMs,
					`Notification channel ${key}`,
				);
				failingChannels.delete(key);
			} catch (error) {
				logger.warn("Notification channel delivery failed", { channelKey: key, pluginId: entry.pluginId, error });
				reportChannelFailure(key, entry, error);
			}
		}),
	);
}

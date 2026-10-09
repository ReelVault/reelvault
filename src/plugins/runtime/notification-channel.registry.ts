import type { OutgoingNotification, PluginNotificationChannel } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/server.config";
import { ConflictError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { PromiseUtils } from "@/utils/promise.utils";

const logger = createLogger("NotificationChannels");

const channels = new Map<string, { pluginId: string; channel: PluginNotificationChannel }>();

/** Returns an unregister function — scopes push it onto their unsubscribe stack. */
export function registerNotificationChannel(pluginId: string, channel: PluginNotificationChannel): () => void {
	const key = `${pluginId}:${channel.id}`;
	if (channels.has(key)) {
		throw new ConflictError(`Notification channel '${channel.id}' is already registered`, {
			code: "plugin.notification_channel.duplicate",
			params: { pluginId, channelId: channel.id },
		});
	}

	channels.set(key, { pluginId, channel });

	return () => channels.delete(key);
}

export function unregisterPluginNotificationChannels(pluginId: string): void {
	for (const [key, entry] of channels) {
		if (entry.pluginId === pluginId) channels.delete(key);
	}
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
			} catch (error) {
				logger.warn("Notification channel delivery failed", { channelKey: key, pluginId: entry.pluginId, error });
			}
		}),
	);
}

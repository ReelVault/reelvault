import type { OutgoingNotification, PluginNotificationChannel } from "@reelvault/sdk/plugin";
import { createLogger } from "@/utils/logger";

const logger = createLogger("NotificationChannels");

const channels = new Map<string, { pluginId: string; channel: PluginNotificationChannel }>();

/** Returns an unregister function — scopes push it onto their unsubscribe stack. */
export function registerNotificationChannel(pluginId: string, channel: PluginNotificationChannel): () => void {
	const key = `${pluginId}:${channel.id}`;
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

	for (const [key, entry] of channels) {
		try {
			await entry.channel.deliver(structuredClone(notification));
		} catch (error) {
			logger.warn("Notification channel delivery failed", { channelKey: key, pluginId: entry.pluginId, error });
		}
	}
}

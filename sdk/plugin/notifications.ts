export interface PluginNotification {
	userId: string;
	profileId?: string | undefined;
	type: string;
	title: string;
	message?: string | undefined;
	data?: Record<string, unknown> | undefined;
	link?: string | undefined;
}

export interface PluginNotifications {
	create(notification: PluginNotification): Promise<void>;
}

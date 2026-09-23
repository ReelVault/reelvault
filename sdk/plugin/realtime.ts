export interface PluginRealtime {
	broadcast(type: string, payload: unknown): void;
	sendToUser(userId: string, type: string, payload: unknown): void;
	sendToProfile(profileId: string, type: string, payload: unknown): void;
	sendToSession(sessionId: string, type: string, payload: unknown): void;
}

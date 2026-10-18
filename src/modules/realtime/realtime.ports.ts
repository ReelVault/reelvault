import { DomainError } from "@/utils/domain.errors";

/** The profile fields realtime needs to check ownership and PIN unlocks. */
export interface RealtimeProfile {
	readonly id: string;
	readonly userId: string;
	readonly pin: string | null | undefined;
}

/**
 * Data realtime reads from the application layer. The application registers an
 * implementation at startup, so this module never imports the database.
 */
export interface RealtimeAccessPort {
	findAdminUserIds(userIds: readonly string[]): Promise<Set<string>>;
	findProfile(profileId: string): Promise<RealtimeProfile | undefined>;
}

let accessPort: RealtimeAccessPort | undefined;

export function wireRealtimeAccess(port: RealtimeAccessPort): void {
	accessPort = port;
}

export function realtimeAccess(): RealtimeAccessPort {
	if (!accessPort) {
		throw new DomainError("internal", "Realtime access port is not wired", { code: "realtime.port_not_wired" });
	}

	return accessPort;
}

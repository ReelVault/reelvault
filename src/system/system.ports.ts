import { DomainError } from "@/utils/domain.errors";
import type { ResourceAlert } from "./resource-allocator/resource-allocator.types";
import type { RescueSnapshot } from "./server-rescue.service";

/** Admin-only realtime notices the system publishes. The app registers the implementation at startup. */
export interface SystemAdminBroadcastPort {
	publishRescueState(state: RescueSnapshot): Promise<void>;
	publishResourceAlert(alert: ResourceAlert): Promise<void>;
}

/** Stops the runtimes the shutdown sequence owns. The app registers the implementations at startup. */
export interface SystemShutdownPort {
	closeRealtime(): void;
	stopLibraryWatchers(): void;
	stopWorkers(): Promise<void>;
	stopDownloadSweeps(): void;
	closeStreaming(): Promise<void>;
	unloadPlugins(): Promise<void>;
}

let broadcastPort: SystemAdminBroadcastPort | undefined;
let shutdownPort: SystemShutdownPort | undefined;

export function wireSystemAdminBroadcast(port: SystemAdminBroadcastPort): void {
	broadcastPort = port;
}

export function systemAdminBroadcast(): SystemAdminBroadcastPort {
	if (!broadcastPort) {
		throw new DomainError("internal", "System admin broadcast port is not wired", { code: "system.broadcast_port_not_wired" });
	}

	return broadcastPort;
}

export function wireSystemShutdown(port: SystemShutdownPort): void {
	shutdownPort = port;
}

export function systemShutdown(): SystemShutdownPort {
	if (!shutdownPort) {
		throw new DomainError("internal", "System shutdown port is not wired", { code: "system.shutdown_port_not_wired" });
	}

	return shutdownPort;
}

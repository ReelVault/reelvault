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

/**
 * A port the app wires at startup and the system reads when it needs it. The
 * port is missing only when the wiring did not run, which is a boot error.
 */
function createPort<TPort>(name: string, code: string): { wire: (port: TPort) => void; get: () => TPort } {
	let port: TPort | undefined;

	return {
		wire: (value) => {
			port = value;
		},
		get: () => {
			if (!port) {
				throw new DomainError("internal", `System ${name} port is not wired`, { code });
			}

			return port;
		},
	};
}

const adminBroadcastPort = createPort<SystemAdminBroadcastPort>("admin broadcast", "system.broadcast_port_not_wired");
const shutdownPort = createPort<SystemShutdownPort>("shutdown", "system.shutdown_port_not_wired");

export function wireSystemAdminBroadcast(port: SystemAdminBroadcastPort): void {
	adminBroadcastPort.wire(port);
}

export function systemAdminBroadcast(): SystemAdminBroadcastPort {
	return adminBroadcastPort.get();
}

export function wireSystemShutdown(port: SystemShutdownPort): void {
	shutdownPort.wire(port);
}

export function systemShutdown(): SystemShutdownPort {
	return shutdownPort.get();
}

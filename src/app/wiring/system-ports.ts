import { libraryWatcherService } from "@/app/libraries/watching/library-watcher.service";
import { downloadsService } from "@/modules/downloads/downloads.service";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { wireSystemAdminBroadcast, wireSystemShutdown } from "@/system/system.ports";
import { workerService } from "@/workers/worker.service";

/** Hands the system runtime its admin broadcasts and shutdown hooks. Called at startup, before any runtime starts. */
export function wireSystemPorts(): void {
	wireSystemAdminBroadcast({
		publishRescueState: async (state) => await realtimeService.sendToAdmins("system.rescue_state", state),
		publishResourceAlert: async (alert) => await realtimeService.sendToAdmins("system.resource_alert", alert),
	});
	wireSystemShutdown({
		closeRealtime: () => realtimeService.shutdown(),
		stopLibraryWatchers: () => libraryWatcherService.shutdown(),
		stopWorkers: async () => await workerService.shutdown(),
		stopDownloadSweeps: () => downloadsService.shutdown(),
		closeStreaming: async () => await streamingManager.shutdown(),
		unloadPlugins: async () => await pluginManager.shutdown(),
	});
}

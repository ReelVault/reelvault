import type { AdminDashboardViewResponse, AdminStats } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { resolveWebVersion } from "@/config/server/web-dist.utils";
import { SERVER_VERSION } from "@/config/version.constants";
import { adminAuditService } from "@/services/admin/admin-audit.service";
import { adminLogsService } from "@/services/admin/admin-logs.service";
import type { AdminServiceState } from "@/services/admin/shared.utils";
import { librariesService } from "@/services/libraries/libraries.service";
import { updateCheckService } from "@/services/updates/update-check.service";
import { describeUpdateEnvironment } from "@/services/updates/update-environment.utils";
import { updateInstallService } from "@/services/updates/update-install.service";
import { runSafely } from "@/utils/safe-execute.utils";
import { workerService } from "@/workers/worker.service";

export function resourceSettings() {
	return {
		monitoringEnabled: serverConfig.resources.monitoringEnabled,
		memoryThresholdPercent: serverConfig.resources.memoryThresholdPercent,
		diskThresholdPercent: serverConfig.resources.diskThresholdPercent,
		enableDynamicThrottling: serverConfig.resources.enableDynamicThrottling,
	};
}

/**
 * Composite view for the admin dashboard page: the six calls the client
 * used to fan out (stats, libraries, worker operations, audit feed, error
 * logs, update status) run here in parallel behind one request.
 */
export async function dashboardView(state: AdminServiceState, loadStats: () => Promise<AdminStats>): Promise<AdminDashboardViewResponse> {
	return await runSafely(state, "dashboardView", async () => {
		await updateCheckService.checkLatest(false);
		const updateState = updateCheckService.getState();

		const [stats, libraries, operations, audit, logs] = await Promise.all([
			loadStats(),
			librariesService.getAll({ limit: 50 }),
			workerService.listOperations({ page: 1, limit: 8 }),
			adminAuditService.getAll({ page: 1, limit: 6 }),
			adminLogsService.getLogs({ level: "warn,error,fatal", limit: 6 }),
		]);

		const installType = updateInstallService.getInstallType();

		return {
			stats,
			libraries: libraries.data,
			operations,
			audit,
			logs,
			update: {
				serverVersion: SERVER_VERSION,
				webVersion: resolveWebVersion(),
				...updateState,
				installType,
				flavor: installType === "archive" ? updateInstallService.getFlavor() : null,
				environment: describeUpdateEnvironment(),
				serverRollbackAvailable: updateInstallService.isRollbackAvailable("server"),
				webRollbackAvailable: updateInstallService.isRollbackAvailable("web"),
				serverLastErrorCode: updateInstallService.getLastError("server") ?? updateState.serverLastError,
				webLastErrorCode: updateInstallService.getLastError("web") ?? updateState.webLastError,
				job: updateInstallService.getJob(),
			},
		};
	});
}

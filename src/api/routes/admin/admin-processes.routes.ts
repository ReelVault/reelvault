import { AdminProcessesResponseSchema } from "@reelvault/sdk/common";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { adminProcessesService } from "@/services/admin/admin-processes.service";
import { adminShell } from "./admin-shell.routes";

export const adminProcessesRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.processes": AdminProcessesResponseSchema,
	})
	.get("/processes", () => adminProcessesService.getProcesses(), {
		rateLimit: routeLimit("admin-processes-list", 120),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.processes" },
		detail: { description: "Snapshot of every live child process (ffmpeg streaming/background, ffprobe, diagnostics)." },
	});

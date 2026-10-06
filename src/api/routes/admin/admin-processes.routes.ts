import { AdminProcessesResponseSchema } from "@reelvault/sdk/common";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { adminProcessesService } from "@/application/admin/admin-processes.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminProcessesRoutes = adminShell()
	.model({
		"admin.processes": AdminProcessesResponseSchema,
	})
	.get("/processes", () => adminProcessesService.getProcesses(), {
		rateLimit: { name: "admin-processes-list", max: 120, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.processes" },
		detail: { description: "Snapshot of every live child process (ffmpeg streaming/background, ffprobe, diagnostics)." },
	});

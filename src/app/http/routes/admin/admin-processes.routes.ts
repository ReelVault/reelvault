import { AdminProcessesResponseSchema } from "@reelvault/sdk/common";
import { adminProcessesService } from "@/app/admin/admin-processes.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { adminShell } from "./admin-shell.routes";

export const adminProcessesRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.processes": AdminProcessesResponseSchema,
	})
	.get("/processes", () => adminProcessesService.getProcesses(), {
		rateLimit: { name: "admin-processes-list", max: 120, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.processes" },
		detail: { description: "Snapshot of every live child process (ffmpeg streaming/background, ffprobe, diagnostics)." },
	});

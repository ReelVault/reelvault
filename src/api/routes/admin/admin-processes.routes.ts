import { AdminProcessesResponseSchema } from "@sdk/common";
import { Elysia } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { adminProcessesService } from "@/application/admin/admin-processes.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminProcessesRoutes = new Elysia()
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"admin.processes": AdminProcessesResponseSchema,
	})
	.guard({ adminOnly: true })
	.get("/processes", () => adminProcessesService.getProcesses(), {
		rateLimit: { name: "admin-processes-list", max: 120, windowMs: 60_000 },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.processes" },
		detail: { description: "Snapshot of every live child process (ffmpeg streaming/background, ffprobe, diagnostics)." },
	});

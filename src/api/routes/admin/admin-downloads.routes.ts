import { t } from "elysia";
import { JobIdParams } from "@/api/schemas/route-params";
import { downloadsService } from "@/modules/downloads/downloads.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminDownloadsRoutes = adminShell({ prefix: "/downloads", tags: ["Admin"] })
	.get("/jobs", async () => await downloadsService.listAll(), {
		rateLimit: { name: "admin-downloads-jobs", max: 60, windowMs: MINUTE },
		detail: { description: "List all users' download jobs (admin overview)." },
	})
	.delete("/jobs/:jobId", async ({ params }) => await downloadsService.delete(params.jobId), {
		rateLimit: { name: "admin-downloads-delete", max: 30, windowMs: MINUTE },
		params: JobIdParams,
		response: { 200: t.Object({ success: t.Boolean() }), 404: "error.response" },
		detail: { description: "Delete any user's download job and file (admin)." },
	});

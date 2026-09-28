import { AdminUpdateInstallResponseSchema, AdminUpdateStatusSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { updateCheckService } from "@/application/updates/update-check.service";
import { updateInstallService } from "@/application/updates/update-install.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";
import { SERVER_VERSION } from "@/version";
import { resolveWebVersion } from "@/web/web-dist";

const TargetBody = t.Object({ target: t.Union([t.Literal("server"), t.Literal("web")]) });

async function buildUpdateStatus(forceCheck: boolean) {
	await updateCheckService.checkLatest(forceCheck);
	const state = updateCheckService.getState();

	return {
		serverVersion: SERVER_VERSION,
		webVersion: resolveWebVersion(),
		...state,
		installType: updateInstallService.getInstallType(),
		flavor: updateInstallService.getInstallType() === "archive" ? updateInstallService.getFlavor() : null,
		serverRollbackAvailable: updateInstallService.isRollbackAvailable("server"),
		webRollbackAvailable: updateInstallService.isRollbackAvailable("web"),
		serverLastError: updateInstallService.getLastError("server") ?? state.serverLastError,
		webLastError: updateInstallService.getLastError("web") ?? state.webLastError,
		job: updateInstallService.getJob(),
	};
}

export const adminUpdateRoutes = new Elysia({ prefix: "/update" })
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"admin.updateStatus": AdminUpdateStatusSchema,
		"admin.updateInstall": AdminUpdateInstallResponseSchema,
	})
	.guard({ adminOnly: true })
	.use(rateLimitMiddleware)
	.get("/status", async () => await buildUpdateStatus(false), {
		rateLimit: { name: "admin-update-status", max: 120, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateStatus" },
		detail: {
			description:
				"Version and update status for both components: running server and web UI versions, the latest releases on GitHub, whether an update (or rollback) is available per component, and the state of a running install job.",
		},
	})
	.post("/check", async () => await buildUpdateStatus(true), {
		rateLimit: { name: "admin-update-check", max: 5, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateStatus" },
		detail: {
			description: "Force a refresh of both GitHub release checks, bypassing the cache.",
		},
	})
	.post("/install", async ({ body }) => await updateInstallService.startInstall(body.target), {
		rateLimit: { name: "admin-update-install", max: 3, windowMs: 10 * MINUTE },
		body: TargetBody,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateInstall" },
		detail: {
			description:
				"Download, verify (SHA256) and install the latest release of the chosen component, then restart (server only — the web UI is live immediately). Only for archive installs — Docker installs are updated by pulling a new image.",
		},
	})
	.post("/rollback", ({ body }) => updateInstallService.startRollback(body.target), {
		rateLimit: { name: "admin-update-rollback", max: 3, windowMs: 10 * MINUTE },
		body: TargetBody,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateInstall" },
		detail: {
			description:
				"Restore the chosen component from its previous-version backup (server rollback restarts, web rollback is live immediately).",
		},
	});

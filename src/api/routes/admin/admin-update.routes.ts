import {
	AdminUpdateCancelResponseSchema,
	AdminUpdateHistoryPageSchema,
	AdminUpdateInstallResponseSchema,
	AdminUpdateStatusSchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { PaginationQuerySchema, ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { resolveWebVersion } from "@/config/server/web-dist.utils";
import { SERVER_VERSION } from "@/config/version.constants";
import { updateCheckService } from "@/services/updates/update-check.service";
import { describeUpdateEnvironment } from "@/services/updates/update-environment.utils";
import { updateHistoryService } from "@/services/updates/update-history.service";
import { updateInstallService } from "@/services/updates/update-install.service";
import { adminShell } from "./admin-shell.routes";

const TargetBody = t.Object({ target: t.Union([t.Literal("server"), t.Literal("web")]) });
const ActionBody = t.Object({ ...TargetBody.properties, force: t.Optional(t.Boolean()) });

async function buildUpdateStatus(forceCheck: boolean) {
	await updateCheckService.checkLatest(forceCheck);
	const state = updateCheckService.getState();

	return {
		serverVersion: SERVER_VERSION,
		webVersion: resolveWebVersion(),
		...state,
		installType: updateInstallService.getInstallType(),
		flavor: updateInstallService.getInstallType() === "archive" ? updateInstallService.getFlavor() : null,
		environment: describeUpdateEnvironment(),
		serverRollbackAvailable: updateInstallService.isRollbackAvailable("server"),
		webRollbackAvailable: updateInstallService.isRollbackAvailable("web"),
		serverLastErrorCode: updateInstallService.getLastError("server") ?? state.serverLastError,
		webLastErrorCode: updateInstallService.getLastError("web") ?? state.webLastError,
		job: updateInstallService.getJob(),
	};
}

export const adminUpdateRoutes = adminShell({ prefix: "/update", tags: ["Admin"] })
	.model({
		"admin.updateStatus": AdminUpdateStatusSchema,
		"admin.updateInstall": AdminUpdateInstallResponseSchema,
		"admin.updateCancel": AdminUpdateCancelResponseSchema,
		"admin.updateHistory": AdminUpdateHistoryPageSchema,
	})
	.get("/status", async () => await buildUpdateStatus(false), {
		rateLimit: routeLimit("admin-update-status", 120),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateStatus" },
		detail: {
			description:
				"Version and update status for both components: running server and web UI versions, the latest releases on GitHub, whether an update (or rollback) is available per component, the state of a running install job, and the environment the server runs in (container engine, rootless, systemd scope).",
		},
	})
	.post("/check", async () => await buildUpdateStatus(true), {
		rateLimit: routeLimit("admin-update-check", 5),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateStatus" },
		detail: {
			description: "Force a refresh of both GitHub release checks, bypassing the cache.",
		},
	})
	.post(
		"/install",
		async ({ body, user }) => await updateInstallService.startInstall(body.target, user?.id ?? null, { force: body.force }),
		{
			rateLimit: routeLimit("admin-update-install", 3, 10 * MINUTE),
			body: ActionBody,
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateInstall" },
			detail: {
				description:
					"Download, verify (SHA256) and install the latest release of the chosen component, then restart (server only — the web UI is live immediately). Only for archive installs — container installs (Docker or Podman) are updated by pulling a new image. A server install is refused with `update.blocked_active_streams` while streams play, because the restart ends them, unless `force` is set.",
			},
		},
	)
	.post("/rollback", ({ body, user }) => updateInstallService.startRollback(body.target, user?.id ?? null, { force: body.force }), {
		rateLimit: routeLimit("admin-update-rollback", 3, 10 * MINUTE),
		body: ActionBody,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateInstall" },
		detail: {
			description:
				"Restore the chosen component from its previous-version backup (server rollback restarts, web rollback is live immediately). A server rollback is refused while streams play unless `force` is set, as for an install.",
		},
	})
	.post("/cancel", ({ body }) => updateInstallService.cancelInstall(body.target), {
		rateLimit: routeLimit("admin-update-cancel", 10),
		body: TargetBody,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateCancel" },
		detail: {
			description:
				"Cancel a running install of the chosen component while it is still downloading, verifying or extracting. The download stops at once and the run is recorded as cancelled, with no failure. Once files are being replaced the install runs to completion and the request is refused with `update.not_cancellable`.",
		},
	})
	.get("/history", async ({ query }) => await updateHistoryService.list(query), {
		rateLimit: routeLimit("admin-update-history", 120),
		query: PaginationQuerySchema({ maxLimit: 50 }),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateHistory" },
		detail: {
			description: "Installs and rollbacks of the server and the web UI, newest first, with their status and error if they failed.",
		},
	});

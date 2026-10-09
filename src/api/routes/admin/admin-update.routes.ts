import { AdminUpdateHistoryPageSchema, AdminUpdateInstallResponseSchema, AdminUpdateStatusSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ClampedNumeric, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { updateCheckService } from "@/application/updates/update-check.service";
import { describeUpdateEnvironment } from "@/application/updates/update-environment";
import { updateHistoryService } from "@/application/updates/update-history.service";
import { updateInstallService } from "@/application/updates/update-install.service";
import { MINUTE } from "@/server.constants";
import { SERVER_VERSION } from "@/version";
import { resolveWebVersion } from "@/web/web-dist";
import { adminShell } from "./admin-shell";

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
		environment: describeUpdateEnvironment(),
		serverRollbackAvailable: updateInstallService.isRollbackAvailable("server"),
		webRollbackAvailable: updateInstallService.isRollbackAvailable("web"),
		serverLastError: updateInstallService.getLastError("server") ?? state.serverLastError,
		webLastError: updateInstallService.getLastError("web") ?? state.webLastError,
		job: updateInstallService.getJob(),
	};
}

export const adminUpdateRoutes = adminShell({ prefix: "/update", tags: ["Admin"] })
	.model({
		"admin.updateStatus": AdminUpdateStatusSchema,
		"admin.updateInstall": AdminUpdateInstallResponseSchema,
		"admin.updateHistory": AdminUpdateHistoryPageSchema,
	})
	.get("/status", async () => await buildUpdateStatus(false), {
		rateLimit: { name: "admin-update-status", max: 120, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateStatus" },
		detail: {
			description:
				"Version and update status for both components: running server and web UI versions, the latest releases on GitHub, whether an update (or rollback) is available per component, the state of a running install job, and the environment the server runs in (container engine, rootless, systemd scope).",
		},
	})
	.post("/check", async () => await buildUpdateStatus(true), {
		rateLimit: { name: "admin-update-check", max: 5, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateStatus" },
		detail: {
			description: "Force a refresh of both GitHub release checks, bypassing the cache.",
		},
	})
	.post("/install", async ({ body, user }) => await updateInstallService.startInstall(body.target, user?.id ?? null), {
		rateLimit: { name: "admin-update-install", max: 3, windowMs: 10 * MINUTE },
		body: TargetBody,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateInstall" },
		detail: {
			description:
				"Download, verify (SHA256) and install the latest release of the chosen component, then restart (server only — the web UI is live immediately). Only for archive installs — container installs (Docker or Podman) are updated by pulling a new image.",
		},
	})
	.post("/rollback", ({ body, user }) => updateInstallService.startRollback(body.target, user?.id ?? null), {
		rateLimit: { name: "admin-update-rollback", max: 3, windowMs: 10 * MINUTE },
		body: TargetBody,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateInstall" },
		detail: {
			description:
				"Restore the chosen component from its previous-version backup (server rollback restarts, web rollback is live immediately).",
		},
	})
	.get("/history", async ({ query }) => await updateHistoryService.list(query), {
		rateLimit: { name: "admin-update-history", max: 120, windowMs: MINUTE },
		query: t.Object({
			page: t.Optional(t.Numeric({ minimum: 1 })),
			limit: t.Optional(ClampedNumeric(1, 50)),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.updateHistory" },
		detail: {
			description: "Installs and rollbacks of the server and the web UI, newest first, with their status and error if they failed.",
		},
	});

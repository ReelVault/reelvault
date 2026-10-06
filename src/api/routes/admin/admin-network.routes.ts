import { RemoteAccessDiagnosticsSchema } from "@reelvault/sdk/common";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { remoteAccessService } from "@/application/admin/remote-access.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminNetworkRoutes = adminShell({ prefix: "/network", tags: ["Admin"] }).get(
	"/remote-access",
	async () => await remoteAccessService.getDiagnostics(),
	{
		rateLimit: { name: "admin-network-remote-access", max: 30, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: RemoteAccessDiagnosticsSchema },
		detail: { description: "Remote-access configuration checks and generated reverse-proxy snippets." },
	},
);

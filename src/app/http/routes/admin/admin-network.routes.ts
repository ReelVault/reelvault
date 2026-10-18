import { RemoteAccessDiagnosticsSchema } from "@reelvault/sdk/common";
import { remoteAccessService } from "@/app/admin/remote-access.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { adminShell } from "./admin-shell.routes";

export const adminNetworkRoutes = adminShell({ prefix: "/network", tags: ["Admin"] }).get(
	"/remote-access",
	async () => await remoteAccessService.getDiagnostics(),
	{
		rateLimit: { name: "admin-network-remote-access", max: 30, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: RemoteAccessDiagnosticsSchema },
		detail: { description: "Remote-access configuration checks and generated reverse-proxy snippets." },
	},
);

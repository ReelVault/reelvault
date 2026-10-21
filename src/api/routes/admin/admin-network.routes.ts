import { RemoteAccessDiagnosticsSchema } from "@reelvault/sdk/common";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { remoteAccessService } from "@/services/admin/remote-access.service";
import { adminShell } from "./admin-shell.routes";

export const adminNetworkRoutes = adminShell({ prefix: "/network", tags: ["Admin"] }).get(
	"/remote-access",
	async () => await remoteAccessService.getDiagnostics(),
	{
		rateLimit: routeLimit("admin-network-remote-access", 30),
		response: { ...ROUTE_ERRORS.ADMIN, 200: RemoteAccessDiagnosticsSchema },
		detail: { description: "Remote-access configuration checks and generated reverse-proxy snippets." },
	},
);

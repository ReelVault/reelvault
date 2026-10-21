import { RemoteAccessDiagnosticsSchema } from "@reelvault/sdk/common";
import { remoteAccessService } from "@/app/admin/remote-access.service";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
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

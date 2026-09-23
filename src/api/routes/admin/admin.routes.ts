import { Elysia } from "elysia";
import { adminAnalyticsRoutes } from "./admin-analytics.routes";
import { adminCollectionsRoutes } from "./admin-collections.routes";
import { adminDatabaseRoutes } from "./admin-database.routes";
import { adminDownloadsRoutes } from "./admin-downloads.routes";
import { adminLiveSessionsRoutes } from "./admin-live-sessions.routes";
import { adminLogsRoutes } from "./admin-logs.routes";
import { adminNetworkRoutes } from "./admin-network.routes";
import { adminPluginRoutes } from "./admin-plugin.routes";
import { adminProcessesRoutes } from "./admin-processes.routes";
import { adminSettingsRoutes } from "./admin-settings.routes";
import { adminSystemRoutes } from "./admin-system.routes";
import { adminTrickplayRoutes } from "./admin-trickplay.routes";
import { adminUsersRoutes } from "./admin-users.routes";
import { adminWorkersRoutes } from "./admin-workers.routes";

export const adminRoutes = new Elysia({
	prefix: "/admin",
	tags: ["Admin"],
})
	.use(adminUsersRoutes)
	.use(adminWorkersRoutes)
	.use(adminSettingsRoutes)
	.use(adminSystemRoutes)
	.use(adminPluginRoutes)
	.use(adminLogsRoutes)
	.use(adminDatabaseRoutes)
	.use(adminTrickplayRoutes)
	.use(adminDownloadsRoutes)
	.use(adminCollectionsRoutes)
	.use(adminAnalyticsRoutes)
	.use(adminNetworkRoutes)
	.use(adminLiveSessionsRoutes)
	.use(adminProcessesRoutes);

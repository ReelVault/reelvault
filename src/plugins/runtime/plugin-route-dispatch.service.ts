import type { PluginRouteAccess } from "@reelvault/sdk/plugin";
import { usersRepository } from "@/database/repositories/users.repository";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { PluginRouteValidationError, pluginRoutesRegistry } from "@/plugins/runtime/plugin.routes";

export interface PluginRouteDispatchInput {
	pluginId: string;
	method: string;
	path: string;
	query: Record<string, string>;
	headers?: Record<string, string> | undefined;
	body: unknown;
	user: { id: string; role?: string; profileId?: string };
}

export type PluginRouteDispatchResult =
	| { type: "success"; status: number; body: unknown; headers?: Record<string, string> | undefined }
	| { type: "not_found" }
	| { type: "forbidden"; message: string }
	| { type: "invalid_request"; message: string };

class PluginRouteDispatchService {
	async dispatch(input: PluginRouteDispatchInput): Promise<PluginRouteDispatchResult> {
		const resolvedRoute = pluginRoutesRegistry.resolve(input.pluginId, input.method, input.path);
		if (!resolvedRoute || pluginRegistry.get(input.pluginId)?.state !== "enabled") return { type: "not_found" };

		const authorization = await this.authorize(input.user, resolvedRoute.route.access ?? "user");
		if (authorization) return authorization;

		try {
			const response = await pluginRoutesRegistry.dispatch(resolvedRoute, {
				params: resolvedRoute.params,
				query: input.query,
				headers: input.headers,
				body: input.body,
				user: {
					id: input.user.id,
					role: input.user.role ?? "user",
					profileId: input.user.profileId,
				},
			});

			return { type: "success", status: response.status ?? 200, body: response.body, headers: response.headers };
		} catch (error) {
			if (error instanceof PluginRouteValidationError) return { type: "invalid_request", message: error.message };

			throw error;
		}
	}

	private async authorize(
		userContext: { id: string; role?: string },
		routeAccess: PluginRouteAccess,
	): Promise<Extract<PluginRouteDispatchResult, { type: "forbidden" }> | undefined> {
		if (!userContext.id) return { type: "forbidden", message: "Authentication required" };

		// Exactly two authorization levels exist for plugin routes: "admin" requires
		// the admin role; "user" means any authenticated user — the plugin performs
		// its own resource scoping.
		if (routeAccess === "admin") {
			if (userContext.role === "admin") return undefined;

			const user = await usersRepository.findById(userContext.id);
			if (user?.role !== "admin") {
				return { type: "forbidden", message: "Admin role required for this plugin route" };
			}
		}

		return undefined;
	}
}

export const pluginRouteDispatchService = new PluginRouteDispatchService();

import type { PluginAccessContext, PluginAccessDenial, PluginAccessPolicy } from "@sdk/plugin";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { ConflictError, ValidationError } from "@/utils/errors";
import { PromiseUtils } from "@/utils/promise.utils";

class PluginAccessBus extends BaseService {
	private readonly policiesByPlugin = new Map<string, Map<string, PluginAccessPolicy>>();

	constructor() {
		super("PluginAccessBus");
	}

	register(pluginId: string, policy: PluginAccessPolicy): () => void {
		if (!policy.id.trim()) throw new ValidationError("Plugin access policy id is required");

		const policies = this.policiesByPlugin.get(pluginId) ?? new Map<string, PluginAccessPolicy>();
		if (policies.has(policy.id)) throw new ConflictError(`Plugin access policy ${policy.id} is already registered`);

		policies.set(policy.id, policy);
		this.policiesByPlugin.set(pluginId, policies);

		return () => this.unregister(pluginId, policy.id);
	}

	/** Runs every registered policy against `context` and returns the first denial, if any. */
	async check(context: PluginAccessContext): Promise<PluginAccessDenial | undefined> {
		if (this.policiesByPlugin.size === 0) return undefined;

		const frozenContext = Object.freeze({ ...context });

		for (const [pluginId, policies] of this.policiesByPlugin) {
			for (const policy of policies.values()) {
				const denial = await this.runPolicy(pluginId, policy, frozenContext);
				if (denial) return denial;
			}
		}

		return undefined;
	}

	offPlugin(pluginId: string): void {
		this.policiesByPlugin.delete(pluginId);
	}

	private async runPolicy(
		pluginId: string,
		policy: PluginAccessPolicy,
		context: PluginAccessContext,
	): Promise<PluginAccessDenial | undefined> {
		try {
			return await PromiseUtils.withTimeout(
				Promise.resolve(policy.beforeAccess(context)),
				serverConfig.plugins.runtime.accessPolicyTimeoutMs,
				"Plugin access policy",
			);
		} catch (error) {
			this.logger.error("Plugin access policy failed", error, { pluginId, policyId: policy.id });

			return {
				allowed: false,
				code: "PLUGIN_ACCESS_UNAVAILABLE",
				message: "Access could not be verified",
			};
		}
	}

	private unregister(pluginId: string, policyId: string): void {
		const policies = this.policiesByPlugin.get(pluginId);
		if (!policies) return;

		policies.delete(policyId);
		if (policies.size === 0) this.policiesByPlugin.delete(pluginId);
	}
}

export const pluginAccessBus = new PluginAccessBus();

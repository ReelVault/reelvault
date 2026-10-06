import type { PluginLifecycleState, PluginLoadPhase, PluginStatus } from "@reelvault/sdk/plugin";
import { pickDefined } from "@/utils/type.utils";

export interface PluginStatusInput {
	id: string;
	name: string;
	version: string;
	state: PluginLifecycleState;
	providers?: number | undefined;
	subtitleProviders?: number | undefined;
	jobs?: number | undefined;
	description?: string | undefined;
	error?: string | undefined;
	failurePhase?: PluginLoadPhase | undefined;
}

/**
 * Single construction point for the admin-facing PluginStatus shape: entity
 * counts default to zero, and absent optional fields are omitted (never
 * emitted as `undefined`) so API responses stay stable.
 */
export function createPluginStatus(input: PluginStatusInput): PluginStatus {
	return {
		id: input.id,
		name: input.name,
		version: input.version,
		state: input.state,
		providers: input.providers ?? 0,
		subtitleProviders: input.subtitleProviders ?? 0,
		jobs: input.jobs ?? 0,
		...pickDefined({
			description: input.description,
			error: input.error,
			failurePhase: input.failurePhase,
		}),
	};
}

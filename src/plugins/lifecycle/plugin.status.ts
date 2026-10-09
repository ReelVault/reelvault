import type { PluginLifecycleState, PluginLoadPhase, PluginStatus } from "@reelvault/sdk/plugin";
import { DomainError } from "@/utils/errors";
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
	errorCode?: string | undefined;
	failurePhase?: PluginLoadPhase | undefined;
}

/**
 * Stable code for a plugin load failure. A domain error keeps its own code;
 * anything else is classified by the phase that failed, so an invalid manifest
 * is never reported as a generic load failure.
 */
export function pluginErrorCode(error: unknown, failurePhase?: PluginLoadPhase): string {
	if (error instanceof DomainError && error.code !== error.category) return error.code;

	return failurePhase === "manifest" ? "plugin.manifest_invalid" : "plugin.load_failed";
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
			errorCode: input.errorCode,
			failurePhase: input.failurePhase,
		}),
	};
}

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
	errorCode?: string | undefined;
	failurePhase?: PluginLoadPhase | undefined;
}

/**
 * Stable code for a plugin load failure. A domain error keeps its own code;
 * anything else is classified by the phase that failed, so an invalid manifest
 * is never reported as a generic load failure. A manifest failure always reports
 * `plugin.manifest_invalid`: the card shows the code without its parameters, and
 * the specific reason belongs to the archive check that reads the error itself.
 */
export function pluginErrorCode(error: unknown, failurePhase?: PluginLoadPhase): string {
	if (failurePhase === "manifest") return "plugin.manifest_invalid";

	if (error instanceof DomainError && error.code !== error.category) return error.code;

	return "plugin.load_failed";
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
			errorCode: input.errorCode,
			failurePhase: input.failurePhase,
		}),
	};
}

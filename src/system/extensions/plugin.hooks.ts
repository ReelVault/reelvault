import type { MetadataCandidate } from "@reelvault/sdk/common";
import { type ArtifactCreationCandidate, type MediaRecognitionCandidate, PluginHookRejection } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { deepFreeze } from "@/system/extensions/plugin.object.utils";
import { createLogger } from "@/utils/logger.utils";
import { withTimeout } from "@/utils/promise.utils";
import { PluginHandlerTable } from "./plugin-handler.registry";

/**
 * Every "before" hook core runs, keyed by name, with the candidate its chain
 * transforms. A hook receives the candidate frozen and returns a replacement, or
 * nothing to keep it; `rejectPluginHook()` stops the action.
 *
 * Opening a new hook point is two steps: add its candidate here, then call
 * `pluginHookBus.run(name, candidate)` where core is about to act. The call site
 * validates what the chain returns, because only it knows which fields a plugin
 * may change.
 */
export interface PluginHookCandidates {
	beforeArtifactCreate: ArtifactCreationCandidate;
	beforeMediaRecognition: MediaRecognitionCandidate;
	beforeMetadataSave: MetadataCandidate;
}

export type PluginHookName = keyof PluginHookCandidates;

export type PluginCandidateHook<N extends PluginHookName> = (input: {
	readonly candidate: Readonly<PluginHookCandidates[N]>;
}) => PluginHookCandidates[N] | undefined | Promise<PluginHookCandidates[N] | undefined>;

type PluginHookTables = { [N in PluginHookName]: PluginHandlerTable<PluginCandidateHook<N>> };

export class PluginHookBus {
	readonly serviceName = "PluginHookBus";
	readonly logger = createLogger("PluginHookBus");

	private readonly tables: PluginHookTables = {
		beforeArtifactCreate: new PluginHandlerTable(),
		beforeMediaRecognition: new PluginHandlerTable(),
		beforeMetadataSave: new PluginHandlerTable(),
	};
	private readonly timeoutMs: number;

	constructor(timeoutMs = serverConfig.plugins.runtime.hookTimeoutMs) {
		this.timeoutMs = timeoutMs;
	}

	register<N extends PluginHookName>(pluginId: string, name: N, hook: PluginCandidateHook<N>): () => void {
		const table: PluginHandlerTable<PluginCandidateHook<N>> = this.tables[name];

		return table.register(pluginId, hook);
	}

	/**
	 * Runs every hook of `name` in registration order. The candidate is cloned and
	 * frozen once, so no hook can mutate the caller's object; a returned value is
	 * frozen in place and becomes the next hook's input. A hook that throws
	 * `PluginHookRejection` aborts the chain; any other failure (a timeout
	 * included) is logged and skipped.
	 */
	async run<N extends PluginHookName>(name: N, candidate: PluginHookCandidates[N]): Promise<PluginHookCandidates[N]> {
		const table: PluginHandlerTable<PluginCandidateHook<N>> = this.tables[name];
		const hooks = table.all();
		if (hooks.length === 0) return candidate;

		let transformed = candidate;
		let frozenInput: Readonly<PluginHookCandidates[N]> = deepFreeze(structuredClone(candidate));

		for (const hook of hooks) {
			try {
				const result = await withTimeout(Promise.resolve(hook({ candidate: frozenInput })), this.timeoutMs, `Plugin ${name} hook`);
				if (result) {
					transformed = result;
					frozenInput = deepFreeze(result);
				}
			} catch (error) {
				if (error instanceof PluginHookRejection) throw error;

				this.logger.error(`Plugin ${name} hook failed`, error);
			}
		}

		return transformed;
	}
}

export const pluginHookBus = new PluginHookBus();

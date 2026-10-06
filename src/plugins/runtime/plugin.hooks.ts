import { type MetadataCandidate, playbackArtifactKinds } from "@reelvault/sdk/common";
import {
	type ArtifactCreationCandidate,
	type BeforeArtifactCreateHook,
	type BeforeMediaRecognitionHook,
	type BeforeMetadataSaveHook,
	type MediaRecognitionCandidate,
	PluginHookRejection,
} from "@reelvault/sdk/plugin";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { PromiseUtils } from "@/utils/promise.utils";
import { isNonEmptyString } from "@/utils/type.utils";
import { deepFreeze } from "../shared/plugin.object.utils";
import { PluginHandlerTable } from "./plugin-handler-table";

const PLAYBACK_ARTIFACT_KINDS_SET = new Set(playbackArtifactKinds);

type CandidateHook<TCandidate> = (input: { candidate: Readonly<TCandidate> }) => Promise<TCandidate | undefined> | TCandidate | undefined;

export class PluginHookBus extends BaseService {
	private readonly beforeArtifactCreateHooks = new PluginHandlerTable<BeforeArtifactCreateHook>();
	private readonly beforeMediaRecognitionHooks = new PluginHandlerTable<BeforeMediaRecognitionHook>();
	private readonly beforeMetadataSaveHooks = new PluginHandlerTable<BeforeMetadataSaveHook>();
	private readonly timeoutMs: number;

	constructor(timeoutMs = serverConfig.plugins.runtime.hookTimeoutMs) {
		super("PluginHookBus");
		this.timeoutMs = timeoutMs;
	}

	beforeMetadataSave(pluginId: string, handler: BeforeMetadataSaveHook): () => void {
		return this.beforeMetadataSaveHooks.register(pluginId, handler);
	}

	beforeArtifactCreate(pluginId: string, handler: BeforeArtifactCreateHook): () => void {
		return this.beforeArtifactCreateHooks.register(pluginId, handler);
	}

	beforeMediaRecognition(pluginId: string, handler: BeforeMediaRecognitionHook): () => void {
		return this.beforeMediaRecognitionHooks.register(pluginId, handler);
	}

	offPlugin(pluginId: string): void {
		this.beforeArtifactCreateHooks.offPlugin(pluginId);
		this.beforeMediaRecognitionHooks.offPlugin(pluginId);
		this.beforeMetadataSaveHooks.offPlugin(pluginId);
	}

	async runBeforeArtifactCreate(candidate: ArtifactCreationCandidate): Promise<ArtifactCreationCandidate> {
		const transformed = await this.runChain(this.beforeArtifactCreateHooks.all(), candidate, "beforeArtifactCreate");
		validateArtifactCandidate(candidate, transformed);

		return transformed;
	}

	async runBeforeMediaRecognition(candidate: MediaRecognitionCandidate): Promise<MediaRecognitionCandidate> {
		return await this.runChain(this.beforeMediaRecognitionHooks.all(), candidate, "beforeMediaRecognition");
	}

	async runBeforeMetadataSave(candidate: MetadataCandidate): Promise<MetadataCandidate> {
		return await this.runChain(this.beforeMetadataSaveHooks.all(), candidate, "beforeMetadataSave");
	}

	/**
	 * Runs every hook in `hooks` in turn. The candidate is cloned and frozen
	 * once before the loop; every hook therefore receives a frozen object and
	 * cannot mutate the shared candidate. When a hook returns a value, that
	 * fresh value is frozen in place (no extra clone) and becomes the input of
	 * the next hook, preserving the chain semantics. A hook that throws
	 * `PluginHookRejection` aborts the whole chain immediately; any other
	 * failure (including a timeout) is logged and skipped.
	 */
	private async runChain<TCandidate>(
		hooks: ReadonlyArray<CandidateHook<TCandidate>>,
		candidate: TCandidate,
		hookName: string,
	): Promise<TCandidate> {
		if (hooks.length === 0) return candidate;

		let transformed = candidate;
		let frozenInput: Readonly<TCandidate> = deepFreeze(structuredClone(candidate));

		for (const hook of hooks) {
			try {
				const result = await PromiseUtils.withTimeout(
					Promise.resolve(hook({ candidate: frozenInput })),
					this.timeoutMs,
					`Plugin ${hookName} hook`,
				);
				if (result) {
					transformed = result;
					frozenInput = deepFreeze(result);
				}
			} catch (error) {
				if (error instanceof PluginHookRejection) throw error;

				this.logger.error(`Plugin ${hookName} hook failed`, error);
			}
		}

		return transformed;
	}
}

function validateArtifactCandidate(original: ArtifactCreationCandidate, candidate: ArtifactCreationCandidate): void {
	if (
		candidate.mediaFileId !== original.mediaFileId ||
		candidate.size !== original.size ||
		!PLAYBACK_ARTIFACT_KINDS_SET.has(candidate.kind) ||
		!isNonEmptyString(candidate.contentType)
	) {
		throw new ValidationError("beforeArtifactCreate returned an invalid artifact candidate");
	}
}

export const pluginHookBus = new PluginHookBus();

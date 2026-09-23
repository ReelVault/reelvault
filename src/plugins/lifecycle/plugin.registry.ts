import type { PluginMediaFile } from "@sdk/common";
import type { Logger } from "@sdk/common/logger";
import type {
	MediaAnalysis,
	MediaAnalyzer,
	MetadataProvider,
	PluginLoadPhase,
	PluginManifest,
	PluginRuntime,
	PluginSlotContribution,
	PluginSlotName,
	PluginStatus,
	PluginTabContribution,
	PluginTabHostName,
	PluginUiManifest,
	ProviderStatus,
	SubtitleProvider,
	SubtitleProviderStatus,
} from "@sdk/plugin";
import { PLUGIN_SLOT_NAMES, PLUGIN_TAB_HOST_NAMES } from "@sdk/plugin";
import { errorMessage, ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { pickDefined } from "@/utils/type.utils";
import { MediaAnalysisFanout } from "./registry/media-analysis.fanout";
import { ProviderLookupCache } from "./registry/provider-lookup.cache";

interface FailedPlugin {
	id: string;
	name: string;
	version: string;
	description?: string | undefined;
	error: string;
	failurePhase?: PluginLoadPhase | undefined;
}

const PRE_ACTIVATION_STATES = new Set<PluginRuntime["state"]>(["discovered", "validated", "resolved", "initialized"]);

const ADVANCE_TRANSITIONS: Record<PluginRuntime["state"], "validated" | "resolved" | "initialized" | undefined> = {
	discovered: "validated",
	validated: "resolved",
	resolved: "initialized",
	initialized: "initialized",
	enabled: undefined,
	disabled: undefined,
	failed: undefined,
	unloaded: undefined,
};

export class PluginRegistry {
	private readonly logger: Logger = createLogger("PluginRegistry");
	private readonly plugins = new Map<string, PluginRuntime>();
	private readonly subtitleProviders = new Map<string, { pluginId: string; provider: SubtitleProvider }>();
	private readonly providerLookup = new ProviderLookupCache();
	private readonly mediaAnalysis = new MediaAnalysisFanout();
	private readonly failures = new Map<string, FailedPlugin>();
	private readonly uiManifests = new Map<string, PluginUiManifest>();
	/** Bumped on every register/unregister so provider-scoped caches keyed by ids are invalidated on reload. */
	private generation = 0;

	begin(manifest: PluginManifest): void {
		if (this.plugins.has(manifest.id)) throw new ValidationError(`Plugin "${manifest.id}" is already registered`);

		this.plugins.set(manifest.id, {
			manifest,
			state: "discovered",
			providerIds: [],
			subtitleProviderIds: [],
			analyzerIds: [],
			jobNames: [],
			failurePhase: "manifest",
		});
		this.failures.delete(manifest.id);
	}

	advance(pluginId: string, state: "validated" | "resolved" | "initialized", phase: PluginLoadPhase): void {
		const runtime = this.requirePlugin(pluginId);
		if (ADVANCE_TRANSITIONS[runtime.state] !== state) {
			throw new ValidationError(`Plugin ${pluginId} cannot transition from ${runtime.state} to ${state}`);
		}

		runtime.state = state;
		runtime.failurePhase = phase;
	}

	markPhase(pluginId: string, phase: PluginLoadPhase): void {
		this.requirePlugin(pluginId).failurePhase = phase;
	}

	register(
		runtime: PluginRuntime,
		providers: readonly MetadataProvider[],
		analyzers: readonly MediaAnalyzer[] = [],
		subtitleProviders: readonly SubtitleProvider[] = [],
	): void {
		const pluginId = runtime.manifest.id;
		const existing = this.plugins.get(pluginId);
		if (existing && (existing.plugin || !PRE_ACTIVATION_STATES.has(existing.state))) {
			throw new ValidationError(`Plugin "${pluginId}" is already registered`);
		}

		this.providerLookup.assertRegisterable(providers);
		this.mediaAnalysis.assertRegisterable(analyzers);

		for (const provider of subtitleProviders) {
			if (this.subtitleProviders.has(provider.id)) {
				throw new ValidationError(
					`Subtitle provider "${provider.id}" is already registered by plugin "${this.subtitleProviders.get(provider.id)?.pluginId ?? "unknown"}"`,
				);
			}
		}

		runtime.state = "initialized";
		runtime.error = undefined;
		runtime.failurePhase = "activation";
		this.plugins.set(pluginId, runtime);
		this.failures.delete(pluginId);
		this.generation += 1;
		this.providerLookup.register(pluginId, providers);
		this.mediaAnalysis.register(pluginId, analyzers);

		for (const provider of subtitleProviders) this.subtitleProviders.set(provider.id, { pluginId, provider });
	}

	enable(pluginId: string): void {
		this.transition(pluginId, "enabled");
	}

	disable(pluginId: string): void {
		this.transition(pluginId, "disabled");
	}

	fail(pluginId: string, error: unknown): void {
		const runtime = this.requirePlugin(pluginId);
		runtime.state = "failed";
		runtime.error = errorMessage(error);
		runtime.failurePhase ??= "activation";
	}

	recordFailure(
		manifest: Pick<PluginManifest, "id" | "name" | "version" | "description">,
		error: unknown,
		failurePhase?: PluginLoadPhase,
	): void {
		this.failures.set(manifest.id, {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			error: errorMessage(error),
			failurePhase,
		});
	}

	unregister(pluginId: string, preserveFailure = false): boolean {
		const runtime = this.plugins.get(pluginId);
		if (!runtime) return false;

		if (preserveFailure && runtime.error) this.recordFailure(runtime.manifest, runtime.error, runtime.failurePhase);

		runtime.state = "unloaded";
		this.generation += 1;
		this.plugins.delete(pluginId);
		this.uiManifests.delete(pluginId);
		this.providerLookup.removeForPlugin(pluginId);
		this.mediaAnalysis.removeForPlugin(pluginId);
		this.removeSubtitleProvidersForPlugin(pluginId);
		this.logger.info("Plugin unregistered", { pluginId });

		return true;
	}

	get(pluginId: string): PluginRuntime | undefined {
		return this.plugins.get(pluginId);
	}

	/** Monotonic counter of register/unregister events — used to epoch provider caches. */
	getGeneration(): number {
		return this.generation;
	}

	getAll(): PluginRuntime[] {
		return [...this.plugins.values()];
	}

	getStatuses(): PluginStatus[] {
		return this.getAll().map((runtime) => ({
			id: runtime.manifest.id,
			name: runtime.manifest.name,
			version: runtime.manifest.version,
			state: runtime.state,
			providers: runtime.providerIds.length,
			subtitleProviders: runtime.subtitleProviderIds.length,
			jobs: runtime.jobNames.length,
			...pickDefined({
				description: runtime.manifest.description,
				error: runtime.error,
				failurePhase: runtime.failurePhase,
			}),
		}));
	}

	getFailedStatuses(): PluginStatus[] {
		return [...this.failures.values()].map((failure) => ({
			id: failure.id,
			name: failure.name,
			version: failure.version,
			state: "failed",
			providers: 0,
			subtitleProviders: 0,
			jobs: 0,
			error: failure.error,
			...pickDefined({
				description: failure.description,
				failurePhase: failure.failurePhase,
			}),
		}));
	}

	getProvider(providerId: string): MetadataProvider | undefined {
		return this.providerLookup.get(providerId);
	}

	getProviders(): MetadataProvider[] {
		return this.providerLookup.getAll();
	}

	getProviderStatus(): ProviderStatus[] {
		return this.providerLookup.getStatuses();
	}

	getSubtitleProvider(providerId: string): SubtitleProvider | undefined {
		return this.subtitleProviders.get(providerId)?.provider;
	}

	getSubtitleProviders(): SubtitleProvider[] {
		return [...this.subtitleProviders.values()].map((entry) => entry.provider);
	}

	getSubtitleProviderStatus(): SubtitleProviderStatus[] {
		return [...this.subtitleProviders.values()].map(({ pluginId, provider }) => ({
			id: provider.id,
			name: provider.name,
			version: provider.version,
			pluginId,
		}));
	}

	async analyzeMedia(media: PluginMediaFile): Promise<MediaAnalysis> {
		return await this.mediaAnalysis.analyze(media);
	}

	clear(): void {
		this.plugins.clear();
		this.subtitleProviders.clear();
		this.providerLookup.clear();
		this.mediaAnalysis.clear();
		this.failures.clear();
		this.uiManifests.clear();
	}

	setUiManifest(pluginId: string, manifest: PluginUiManifest): void {
		// One global browser custom-element registry: two plugins claiming one tag
		// must fail the load with a diagnosable error, not render the wrong element.
		const incomingTags = collectUiManifestTags(manifest);
		if (incomingTags.size > 0) {
			for (const [otherId, otherManifest] of this.uiManifests) {
				if (otherId === pluginId) continue;

				for (const tag of collectUiManifestTags(otherManifest)) {
					if (incomingTags.has(tag)) {
						throw new ValidationError(`Plugin "${pluginId}" and plugin "${otherId}" both declare the custom element "${tag}"`);
					}
				}
			}
		}

		this.uiManifests.set(pluginId, manifest);
	}

	getUiManifest(pluginId: string): PluginUiManifest | undefined {
		return this.uiManifests.get(pluginId);
	}

	/**
	 * UI manifests of enabled plugins, with admin-only surfaces removed for
	 * non-admin callers. Tabs and slot actions that target a filtered surface
	 * are dropped too, so the host never renders a dangling link.
	 */
	getUiManifestsForRole(isAdmin: boolean): Record<string, PluginUiManifest> {
		const result: Record<string, PluginUiManifest> = {};
		for (const [pluginId, manifest] of this.uiManifests) {
			// Disabled plugins disappear from the UI surface entirely.
			if (this.plugins.get(pluginId)?.state !== "enabled") continue;

			result[pluginId] = isAdmin ? manifest : filterUiManifestForRole(manifest);
		}

		return result;
	}

	private transition(pluginId: string, state: "enabled" | "disabled"): void {
		const runtime = this.requirePlugin(pluginId);
		runtime.state = state;
		runtime.error = undefined;
		runtime.failurePhase = undefined;
	}

	private requirePlugin(pluginId: string): PluginRuntime {
		const runtime = this.plugins.get(pluginId);
		if (!runtime) throw new ValidationError(`Plugin ${pluginId} is not registered`);

		return runtime;
	}

	private removeSubtitleProvidersForPlugin(pluginId: string): void {
		for (const [key, entry] of this.subtitleProviders) {
			if (entry.pluginId === pluginId) this.subtitleProviders.delete(key);
		}
	}
}

const UI_TAB_HOST_NAMES = PLUGIN_TAB_HOST_NAMES;

const UI_SLOT_NAMES = PLUGIN_SLOT_NAMES;

/**
 * Drops admin-only surfaces from a manifest for non-admin callers, together
 * with the tabs and slot actions that reference them. Keeping this in one place
 * guarantees the host never receives a contribution pointing at a hidden page.
 */
function filterUiManifestForRole(manifest: PluginUiManifest): PluginUiManifest {
	const pages = manifest.pages?.filter((page) => !page.adminOnly);
	const pageIds = new Set((pages ?? []).map((page) => page.id));
	const dialogs = manifest.dialogs?.filter((dialog) => !dialog.adminOnly);
	const dialogIds = new Set((dialogs ?? []).map((dialog) => dialog.id));

	return {
		...manifest,
		...(manifest.pages ? { pages } : {}),
		...(manifest.dialogs ? { dialogs } : {}),
		...(manifest.tabs ? { tabs: filterTabsForRole(manifest.tabs, pageIds) } : {}),
		...(manifest.slots ? { slots: filterSlotsForRole(manifest.slots, pageIds, dialogIds) } : {}),
	};
}

function filterTabsForRole(
	tabs: Partial<Record<PluginTabHostName, PluginTabContribution[]>>,
	pageIds: ReadonlySet<string>,
): Partial<Record<PluginTabHostName, PluginTabContribution[]>> {
	const result: Partial<Record<PluginTabHostName, PluginTabContribution[]>> = {};
	for (const host of UI_TAB_HOST_NAMES) {
		const contributions = tabs[host];
		if (!contributions) continue;

		result[host] = contributions.filter((tab) => !tab.adminOnly && pageIds.has(tab.page));
	}

	return result;
}

function filterSlotsForRole(
	slots: Partial<Record<PluginSlotName, PluginSlotContribution[]>>,
	pageIds: ReadonlySet<string>,
	dialogIds: ReadonlySet<string>,
): Partial<Record<PluginSlotName, PluginSlotContribution[]>> {
	const result: Partial<Record<PluginSlotName, PluginSlotContribution[]>> = {};
	for (const slot of UI_SLOT_NAMES) {
		const contributions = slots[slot];
		if (!contributions) continue;

		result[slot] = contributions.filter((contribution) => slotContributionIsVisible(contribution, pageIds, dialogIds));
	}

	return result;
}

function slotContributionIsVisible(
	contribution: PluginSlotContribution,
	pageIds: ReadonlySet<string>,
	dialogIds: ReadonlySet<string>,
): boolean {
	if (contribution.adminOnly) return false;

	const action = contribution.action;
	if (!action) return true;

	if (action.type === "page") return pageIds.has(action.page);

	if (action.type === "dialog") return dialogIds.has(action.dialog);

	return true;
}

/** Every custom element tag a plugin UI manifest registers. */
function collectUiManifestTags(manifest: PluginUiManifest): Set<string> {
	const tags = new Set<string>();
	for (const page of manifest.pages ?? []) {
		if (page.tag) tags.add(page.tag);
	}

	for (const dialog of manifest.dialogs ?? []) {
		if (dialog.tag) tags.add(dialog.tag);
	}

	for (const contributions of Object.values(manifest.slots ?? {})) {
		for (const contribution of contributions) {
			if (contribution.element?.tag) tags.add(contribution.element.tag);
		}
	}

	return tags;
}

export const pluginRegistry = new PluginRegistry();

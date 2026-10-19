import { loadPluginManifest } from "@/plugins/lifecycle/plugin.manifest";
import { directoryNameOf, type PluginManagerState } from "./state.utils";

export interface PluginPackageDetails {
	capabilities: string[];
	configReadError?: string;
	installedAt?: string;
	source?: string;
	integrityOk?: boolean;
	/** Installer-managed plugins only: the admin refuses the CSP sources the manifest declares. */
	cspDisabled?: boolean;
	/** Installer-managed plugins only: the installed version is kept, so catalog updates are not offered. */
	pinned?: boolean;
}

/** The install-record fields the admin view shows; absent for a plugin that is not installed. */
type InstalledPluginState = Partial<Pick<PluginPackageDetails, "installedAt" | "source" | "integrityOk" | "cspDisabled" | "pinned">>;

/** The loaded manifest when there is one; otherwise the one on disk, so a failed or disabled plugin still reports its capabilities. */
async function declaredCapabilities(state: PluginManagerState, pluginId: string, directory: string): Promise<string[]> {
	const runtime = state.registry.get(pluginId);
	if (runtime) return runtime.manifest.capabilities;

	try {
		return (await loadPluginManifest(directory)).capabilities;
	} catch {
		return [];
	}
}

/** What the admin view shows about a plugin's package, beyond its runtime status. */
export async function getPackageDetails(state: PluginManagerState, pluginId: string): Promise<PluginPackageDetails> {
	const directory = state.config.resolvePluginDirectory(await directoryNameOf(state, pluginId));
	const configReadError = await state.config.readError(directory);
	const installed = await state.installer
		.list()
		.then((records) => records.find((entry) => entry.id === pluginId)?.record)
		.catch(() => null);

	let installState: InstalledPluginState = {};
	if (installed) {
		installState = {
			installedAt: installed.installedAt,
			source: installed.source,
			integrityOk: !state.integrityIssues.has(pluginId),
			cspDisabled: installed.cspDisabled === true,
			pinned: installed.pinned === true,
		};
	}

	return {
		capabilities: await declaredCapabilities(state, pluginId, directory),
		...(configReadError ? { configReadError } : {}),
		...installState,
	};
}

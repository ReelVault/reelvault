import type { MetadataProvider } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import type { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { PromiseUtils } from "@/utils/promise.utils";
import { isNotNullish } from "@/utils/type.utils";
import { trimNameAndOverview } from "./match-ranking.utils";
import type { ProviderServiceState } from "./shared.utils";

/**
 * Calls `fetchOne` against every registered provider in parallel and returns
 * the name/overview-trimmed results from providers that resolved to a value.
 * A provider that throws, or resolves to `null`/`undefined` (no data for
 * that provider), is simply omitted rather than failing the whole call.
 */
export async function fetchFromEveryProvider<TMetadata extends { name?: string; overview?: string }>(
	state: ProviderServiceState,
	fetchOne: (provider: ReturnType<typeof pluginRegistry.getProviders>[number]) => Promise<TMetadata | null | undefined>,
): Promise<Array<{ provider: string; metadata: TMetadata }>> {
	const providers = await metadataProviderSettingsService.getOrderedProviders();

	return await fetchFromProviders(
		state,
		providers.map((provider) => ({ providerId: provider.id, provider })),
		(provider) => fetchOne(provider),
	);
}

/** Shared concurrency/try-catch/trim/filter core for provider fan-out fetches. */
export async function fetchFromProviders<
	TEntry extends { providerId: string; provider: MetadataProvider | undefined },
	TMetadata extends { name?: string | undefined; overview?: string | undefined },
>(
	state: ProviderServiceState,
	entries: readonly TEntry[],
	fetchOne: (provider: MetadataProvider, entry: TEntry) => Promise<TMetadata | null | undefined>,
): Promise<Array<{ provider: string; metadata: TMetadata }>> {
	const results = await PromiseUtils.mapConcurrent(entries, serverConfig.plugins.providers.concurrency, async (entry) => {
		const provider = entry.provider;
		if (!provider) return null;

		try {
			const metadata = await fetchOne(provider, entry);

			return metadata ? { provider: entry.providerId, metadata: trimNameAndOverview(metadata) } : null;
		} catch (error) {
			state.logger.error(`Provider ${entry.providerId} failed`, error);

			return null;
		}
	});

	return results.filter((result) => isNotNullish(result));
}

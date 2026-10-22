import type { MetadataProvider } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import type { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { mapConcurrent } from "@/utils/promise.utils";
import { isNotNullish } from "@/utils/type.utils";
import { trimNameAndOverview } from "./match-ranking.utils";
import { providerLog } from "./provider-lookup.utils";

/**
 * Calls `fetchOne` against every registered provider in parallel and returns
 * the name/overview-trimmed results from providers that resolved to a value.
 * A provider that throws, or resolves to `null`/`undefined` (no data for
 * that provider), is simply omitted rather than failing the whole call.
 */
export async function fetchFromEveryProvider<TMetadata extends { name?: string; overview?: string }>(
	fetchOne: (provider: ReturnType<typeof pluginRegistry.getProviders>[number]) => Promise<TMetadata | null | undefined>,
): Promise<Array<{ provider: string; metadata: TMetadata }>> {
	const providers = await metadataProviderSettingsService.getOrderedProviders();

	return await fetchFromProviders(
		providers.map((provider) => ({ providerId: provider.id, provider })),
		(provider) => fetchOne(provider),
	);
}

/**
 * Runs `fetchOne` over `entries` with bounded concurrency. A provider that
 * throws is reported to `onError` and omitted; `null`/`undefined` is omitted
 * without reporting. One implementation for every provider fan-out.
 */
export async function mapProvidersSafely<TEntry, TResult>(
	entries: readonly TEntry[],
	fetchOne: (entry: TEntry) => Promise<TResult | null | undefined>,
	onError: (entry: TEntry, error: unknown) => void,
	concurrency: number = serverConfig.plugins.providers.concurrency,
): Promise<TResult[]> {
	const results = await mapConcurrent(entries, concurrency, async (entry) => {
		try {
			return await fetchOne(entry);
		} catch (error) {
			onError(entry, error);

			return null;
		}
	});

	return results.filter((result) => isNotNullish(result));
}

/** Shared concurrency/try-catch/trim/filter core for provider fan-out fetches. */
export async function fetchFromProviders<
	TEntry extends { providerId: string; provider: MetadataProvider | undefined },
	TMetadata extends { name?: string | undefined; overview?: string | undefined },
>(
	entries: readonly TEntry[],
	fetchOne: (provider: MetadataProvider, entry: TEntry) => Promise<TMetadata | null | undefined>,
): Promise<Array<{ provider: string; metadata: TMetadata }>> {
	return await mapProvidersSafely(
		entries,
		async (entry) => {
			const provider = entry.provider;
			if (!provider) return null;

			const metadata = await fetchOne(provider, entry);

			return metadata ? { provider: entry.providerId, metadata: trimNameAndOverview(metadata) } : null;
		},
		(entry, error) => providerLog.logger.error(`Provider ${entry.providerId} failed`, error),
	);
}

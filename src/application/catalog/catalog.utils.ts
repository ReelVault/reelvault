/** Maps raw provider entries to the { providerId, externalId } shape used by fetcher APIs. */
export function mapProviderLinks(providers: ReadonlyArray<{ name: string; externalId: string }>) {
	return providers.map((provider) => ({ providerId: provider.name, externalId: provider.externalId }));
}

/** Extracts the first provider result that carries metadata. */
export function findFirstProviderResult<T extends { metadata?: unknown }>(results: T[]): T["metadata"] | undefined {
	return results.find((r) => r.metadata)?.metadata;
}

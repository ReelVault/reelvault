import type { MetadataProvider, SubtitleProvider } from "@reelvault/sdk/plugin";

/** Minimal provider entities shared by the registry and scope tests. */
export function createProvider(id: string): MetadataProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: () => Promise.resolve(),
		search: () => Promise.resolve([]),
		getDetails: () => Promise.resolve(null),
		getSeasonDetails: () => Promise.resolve(null),
		getEpisodeDetails: () => Promise.resolve(null),
	};
}

export function createSubtitleProvider(id: string): SubtitleProvider {
	return {
		id,
		name: id.toUpperCase(),
		version: "1.0.0",
		initialize: () => Promise.resolve(),
		search: () => Promise.resolve([]),
		download: () => Promise.resolve(null),
	};
}

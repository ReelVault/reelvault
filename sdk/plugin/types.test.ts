import { describe, expect, test } from "bun:test";
import type { ExternalIdentifierAwareProvider, ExternalIdentifiers, ProviderMediaType } from ".";

describe("provider domain contracts", () => {
	test("models a provider lookup by external identifiers without a feature dependency", async () => {
		const identifiers: ExternalIdentifiers = { imdb: "tt0816692", tmdb: "157336" };
		const provider: ExternalIdentifierAwareProvider<{ id: string }> = {
			getDetailsByExternalIds: async (type: ProviderMediaType, values: ExternalIdentifiers) =>
				type === "movie" && values.tmdb ? { id: values.tmdb } : null,
		};

		expect(await provider.getDetailsByExternalIds("movie", identifiers)).toEqual({ id: "157336" });
	});
});

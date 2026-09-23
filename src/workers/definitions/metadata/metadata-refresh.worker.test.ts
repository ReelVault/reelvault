import { describe, expect, test } from "bun:test";
import { type MetadataRefreshTaskDependencies, refreshMetadataTask } from "./metadata-refresh.worker";

function dependencies(overrides: Partial<MetadataRefreshTaskDependencies> = {}): MetadataRefreshTaskDependencies {
	return {
		refresh: async (metadataId) => ({ metadataId, providerId: "provider-1" }),
		...overrides,
	};
}

describe("metadata refresh application task", () => {
	test("refreshes a single metadata item without worker runtime", async () => {
		const refreshed: string[] = [];
		const result = await refreshMetadataTask(
			{ metadataId: "metadata-1" },
			{ correlationId: "correlation-1" },
			dependencies({
				refresh: (metadataId, options) => {
					const correlation = typeof options === "string" ? options : options?.correlationId;
					refreshed.push(`${metadataId}:${correlation}`);

					return Promise.resolve({ metadataId, providerId: "provider-1" });
				},
			}),
		);

		expect(result).toEqual({ metadataId: "metadata-1", providerId: "provider-1" });
		expect(refreshed).toEqual(["metadata-1:correlation-1"]);
	});

	test("converts refresh failures to domain errors", async () => {
		await expect(
			refreshMetadataTask(
				{ metadataId: "metadata-2" },
				{},
				dependencies({
					refresh: () => Promise.reject(new Error("provider unavailable")),
				}),
			),
		).rejects.toMatchObject({ code: "internal" });
	});
});

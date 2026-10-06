import { afterEach, describe, expect, test } from "bun:test";
import { metadataRefreshService } from "@/application/catalog/metadata/metadata-refresh.runtime";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { refreshMetadataTask } from "./metadata-refresh.worker";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("metadata refresh application task", () => {
	test("refreshes a single metadata item with the task correlation id", async () => {
		const refreshed: string[] = [];
		activeStubs.push(
			stubMethod(metadataRefreshService, "refresh", (metadataId: string, options?: { correlationId?: string | undefined }) => {
				refreshed.push(`${metadataId}:${options?.correlationId}`);

				return Promise.resolve({ metadataId, providerId: "provider-1" });
			}),
		);

		const result = await refreshMetadataTask({ metadataId: "metadata-1" }, { correlationId: "correlation-1" });

		expect(result).toEqual({ metadataId: "metadata-1", providerId: "provider-1" });
		expect(refreshed).toEqual(["metadata-1:correlation-1"]);
	});

	test("converts refresh failures to domain errors", async () => {
		activeStubs.push(stubMethod(metadataRefreshService, "refresh", () => Promise.reject(new Error("provider unavailable"))));

		await expect(refreshMetadataTask({ metadataId: "metadata-2" })).rejects.toMatchObject({ code: "internal" });
	});
});

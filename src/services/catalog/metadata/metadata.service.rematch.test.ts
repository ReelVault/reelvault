import { afterEach, describe, expect, test } from "bun:test";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { insertMetadata, insertMetadataLockedFields, selectMetadata } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { metadataService } from "./metadata.service";

/**
 * A rematch keeps the administrator's locked fields. `overwriteLocked` is the only way to replace them.
 * The provider lookup and the artwork pipeline are stubbed (plugin and image-file boundaries); the title is
 * read back from the real metadata table.
 */

const { client } = useTestDatabase();

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

async function seedLockedTitle(metadataId: string): Promise<void> {
	await insertMetadata(client(), { id: metadataId, stableKey: metadataId, title: "Stored", type: "movie", releaseDate: "2020-01-01" });
	await insertMetadataLockedFields(client(), { metadataId, field: "title" });
}

async function storedTitle(metadataId: string): Promise<string | undefined> {
	const row = (await selectMetadata(client())).find((item) => item.id === metadataId);

	return row?.title;
}

function stubProviderBoundary(): void {
	stubs.push(
		stubMethod(providerService, "fetchDetailsByProvider", (_providerId: string, _type: string, externalId: string) =>
			Promise.resolve({ externalId, title: "Provider title", releaseDate: "1999-01-01" }),
		),
		stubMethod(imageProcessingService, "replaceProviderArtwork", () => Promise.resolve()),
	);
}

describe("metadataService.rematch locked fields", () => {
	test("a rematch keeps a locked title when the request does not overwrite it", async () => {
		await seedLockedTitle("meta-rematch-a");
		stubProviderBoundary();

		await metadataService.rematch("meta-rematch-a", { providerId: "tmdb", externalId: "550" });

		expect(await storedTitle("meta-rematch-a")).toBe("Stored");
	});

	test("overwriteLocked lets the rematch replace the locked title as well", async () => {
		await seedLockedTitle("meta-rematch-b");
		stubProviderBoundary();

		await metadataService.rematch("meta-rematch-b", { providerId: "tmdb", externalId: "550", overwriteLocked: true });

		expect(await storedTitle("meta-rematch-b")).toBe("Provider title");
	});
});

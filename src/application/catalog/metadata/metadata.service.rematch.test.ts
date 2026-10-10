import { afterEach, describe, expect, test } from "bun:test";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { metadataService } from "./metadata.service";

/**
 * A rematch keeps the administrator's locked fields. `overwriteLocked` is the only way to replace them,
 * so the locked list handed to the persistence step is empty exactly when the request asks for it.
 */

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubRematch(lockedFields: string[]): Array<{ lockedFields: string[] }> {
	const persisted: Array<{ lockedFields: string[] }> = [];
	stubs.push(
		stubMethod(metadataRepository, "findByIdForRead", (id: string) => Promise.resolve({ id, type: "movie", title: "Stored" })),
		stubMethod(metadataRepository, "getLockedFields", () => Promise.resolve(lockedFields)),
		stubMethod(mediaRepository, "findRootsByMetadataId", () => Promise.resolve([])),
		stubMethod(providerService, "fetchDetailsByProvider", (_providerId: string, _type: string, externalId: string) =>
			Promise.resolve({ externalId, title: "Provider title", releaseDate: "1999-01-01" }),
		),
		stubMethod(metadataPersistenceRepository, "rematchProviderMetadata", (input: { lockedFields: string[] }) => {
			persisted.push(input);

			return Promise.resolve();
		}),
		stubMethod(imageProcessingService, "replaceProviderArtwork", () => Promise.resolve()),
	);

	return persisted;
}

describe("metadataService.rematch locked fields", () => {
	test("a rematch keeps the locked fields when the request does not overwrite them", async () => {
		const persisted = stubRematch(["title"]);

		await metadataService.rematch("meta-rematch-a", { providerId: "tmdb", externalId: "550" });

		expect(persisted.at(-1)?.lockedFields).toEqual(["title"]);
	});

	test("overwriteLocked lets the rematch replace the locked fields as well", async () => {
		const persisted = stubRematch(["title"]);

		await metadataService.rematch("meta-rematch-b", { providerId: "tmdb", externalId: "550", overwriteLocked: true });

		expect(persisted.at(-1)?.lockedFields).toEqual([]);
	});
});

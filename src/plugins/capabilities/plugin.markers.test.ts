import { describe, expect, test } from "bun:test";
import type { PluginEventMap } from "@reelvault/sdk/plugin";
import { mediaMarkersRepository } from "@/app/repositories/media-markers.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginMarkersService } from "./plugin.markers";

const db = useTestDatabase();

/** Media file `mf-1` holding two plugins' markers and one manual marker. */
async function seedMarkers(): Promise<void> {
	const client = db.client();
	await client.insert(schema.libraries).values({ id: "lib-1", name: "Movies", type: "movies" });
	await client
		.insert(schema.metadata)
		.values({ id: "meta-1", stableKey: "movie-heat", title: "Heat", type: "movie", releaseDate: "1995-12-15" });
	await client.insert(schema.movies).values({ id: "movie-1", stableKey: "movie-heat", metadataId: "meta-1" });
	await client.insert(schema.mediaFiles).values({
		id: "mf-1",
		libraryId: "lib-1",
		metadataId: "meta-1",
		movieId: "movie-1",
		fileName: "Heat.mkv",
		filePath: "/media/heat.mkv",
		size: 1_000,
		duration: 3_600,
		isDefault: true,
	});
	await client.insert(schema.mediaMarkers).values([
		{
			mediaFileId: "mf-1",
			type: "intro",
			startSeconds: 0,
			endSeconds: 10,
			label: "Old intro",
			source: "plugin",
			pluginId: "intro-skipper",
		},
		{
			mediaFileId: "mf-1",
			type: "credits",
			startSeconds: 1400,
			endSeconds: 1460,
			label: "Recap credits",
			source: "plugin",
			pluginId: "recap",
		},
		{ mediaFileId: "mf-1", type: "intro", startSeconds: 5, endSeconds: 20, label: "Manual intro", source: "manual", pluginId: null },
	]);
}

async function storedMarkers(): Promise<Array<{ label: string | null; pluginId: string | null }>> {
	const markers = await mediaMarkersRepository.findByMediaFileId("mf-1");

	return markers
		.map((marker) => ({ label: marker.label, pluginId: marker.pluginId }))
		.toSorted((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
}

/** Resolves with the next `media.markers.updated` payload the event bus delivers. */
function nextMarkersUpdate(): Promise<PluginEventMap["media.markers.updated"]> {
	return new Promise((resolve) => {
		const unsubscribe = pluginEventBus.on("markers-test", "media.markers.updated", (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

const introSkipperMarkers = [
	{ type: "intro", startSeconds: 15.5, endSeconds: 90, label: "Opening" },
	{ type: "credits", startSeconds: 1400, endSeconds: 1460, label: "End Credits" },
] as const;

describe("PluginMarkersService.setMarkers", () => {
	test("refuses to store markers for a media file that does not exist", async () => {
		await expect(pluginMarkersService.setMarkers("intro-skipper", "mf-missing", introSkipperMarkers)).rejects.toMatchObject({
			category: "not_found",
			code: "media_file.not_found",
		});
	});

	test("replaces only the calling plugin's markers and keeps other plugins' and manual markers", async () => {
		await seedMarkers();

		await pluginMarkersService.setMarkers("intro-skipper", "mf-1", introSkipperMarkers);

		expect(await storedMarkers()).toEqual([
			{ label: "End Credits", pluginId: "intro-skipper" },
			{ label: "Manual intro", pluginId: null },
			{ label: "Opening", pluginId: "intro-skipper" },
			{ label: "Recap credits", pluginId: "recap" },
		]);
	});

	test("publishes media.markers.updated with the number of saved markers", async () => {
		await seedMarkers();
		const update = nextMarkersUpdate();

		await pluginMarkersService.setMarkers("intro-skipper", "mf-1", introSkipperMarkers);

		await expect(update).resolves.toMatchObject({ mediaFileId: "mf-1", markerCount: 2 });
	});
});

describe("PluginMarkersService.clearMarkers", () => {
	test("removes only the calling plugin's markers", async () => {
		await seedMarkers();

		await pluginMarkersService.clearMarkers("intro-skipper", "mf-1");

		expect(await storedMarkers()).toEqual([
			{ label: "Manual intro", pluginId: null },
			{ label: "Recap credits", pluginId: "recap" },
		]);
	});

	test("publishes media.markers.updated reporting zero markers", async () => {
		await seedMarkers();
		const update = nextMarkersUpdate();

		await pluginMarkersService.clearMarkers("intro-skipper", "mf-1");

		await expect(update).resolves.toMatchObject({ mediaFileId: "mf-1", markerCount: 0 });
	});
});

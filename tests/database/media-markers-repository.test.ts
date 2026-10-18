import { beforeEach, describe, expect, test } from "bun:test";
import { mediaMarkersRepository } from "@/app/repositories/media-markers.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../helpers/media.fixture";
import { useTestDatabase } from "../helpers/test-database.helper";

const db = useTestDatabase();

type FileKey = "alpha" | "beta" | "gamma";

interface MarkerFixture {
	id: string;
	file: FileKey;
	type: "intro" | "credits" | "recap" | "chapter" | "highlight";
	label: string | null;
	source: "automatic" | "manual" | "plugin";
	pluginId: string | null;
}

// Created in this order, so the repository's createdAt ordering is the id order.
const FIXTURES: MarkerFixture[] = [
	{ id: "m1", file: "alpha", type: "intro", label: "Opening", source: "automatic", pluginId: null },
	{ id: "m2", file: "alpha", type: "credits", label: "Closing credits", source: "manual", pluginId: null },
	{ id: "m3", file: "beta", type: "intro", label: null, source: "plugin", pluginId: "skip-plugin" },
	{ id: "m4", file: "gamma", type: "recap", label: "Previously 50% recap", source: "automatic", pluginId: null },
	{ id: "m5", file: "gamma", type: "highlight", label: "Dragon 500", source: "manual", pluginId: null },
];

let fileIds: Record<FileKey, string>;

beforeEach(async () => {
	const client = db.client();
	fileIds = {
		alpha: await insertMovieMediaFile(client, "/movies/alpha.mkv", "meta-alpha"),
		beta: await insertMovieMediaFile(client, "/movies/beta.mkv", "meta-beta"),
		gamma: await insertMovieMediaFile(client, "/movies/gamma.mkv", "meta-gamma"),
	};
	await client.insert(schema.mediaMarkers).values(
		FIXTURES.map((row, index) => ({
			id: row.id,
			mediaFileId: fileIds[row.file],
			type: row.type,
			startSeconds: 0,
			endSeconds: 10,
			label: row.label,
			source: row.source,
			pluginId: row.pluginId,
			createdAt: new Date(index * 1000),
			updatedAt: new Date(index * 1000),
		})),
	);
});

const idsOf = (markers: Array<{ id: string }>) => markers.map((marker) => marker.id);

describe("mediaMarkersRepository.findAll filters", () => {
	test("returns every marker in creation order without filters", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll())).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	});

	test("filters by type and by source", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ type: "intro" }))).toEqual(["m1", "m3"]);
		expect(idsOf(await mediaMarkersRepository.findAll({ source: "manual" }))).toEqual(["m2", "m5"]);
	});

	test("combines type and source with AND", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ type: "intro", source: "plugin" }))).toEqual(["m3"]);
	});

	test("q matches the label case-insensitively", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "CLOSING" }))).toEqual(["m2"]);
	});

	test("q matches the media file id, the plugin id and the type", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ q: fileIds.beta }))).toEqual(["m3"]);
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "skip-plugin" }))).toEqual(["m3"]);
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "highlight" }))).toEqual(["m5"]);
	});

	test("q treats % and _ as literal text", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "%" }))).toEqual(["m4"]);
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "_" }))).toEqual([]);
	});

	test("a blank q is no filter, and q is trimmed", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "   " }))).toEqual(["m1", "m2", "m3", "m4", "m5"]);
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "  Opening " }))).toEqual(["m1"]);
	});

	test("combines a text query with type", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ type: "intro", q: "open" }))).toEqual(["m1"]);
	});

	test("limit caps the filtered result", async () => {
		expect(idsOf(await mediaMarkersRepository.findAll({ limit: 2 }))).toEqual(["m1", "m2"]);
		expect(idsOf(await mediaMarkersRepository.findAll({ limit: 2, source: "manual" }))).toEqual(["m2", "m5"]);
	});
});

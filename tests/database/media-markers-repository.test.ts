import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";

const client = databaseFactory.getClient();

interface MarkerRow {
	id: string;
	mediaFileId: string;
	type: "intro" | "credits" | "recap" | "chapter" | "highlight";
	label: string | null;
	source: "automatic" | "manual" | "plugin";
	pluginId: string | null;
}

// Created in this order, so the repository's createdAt ordering is the id order.
const FIXTURES: MarkerRow[] = [
	{ id: "m1", mediaFileId: "file-alpha", type: "intro", label: "Opening", source: "automatic", pluginId: null },
	{ id: "m2", mediaFileId: "file-alpha", type: "credits", label: "Closing credits", source: "manual", pluginId: null },
	{ id: "m3", mediaFileId: "file-beta", type: "intro", label: null, source: "plugin", pluginId: "skip-plugin" },
	{ id: "m4", mediaFileId: "file-gamma", type: "recap", label: "Previously 50% recap", source: "automatic", pluginId: null },
	{ id: "m5", mediaFileId: "file-gamma", type: "highlight", label: "Dragon 500", source: "manual", pluginId: null },
];

beforeAll(async () => {
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS media_markers (
				id TEXT PRIMARY KEY NOT NULL,
				media_file_id TEXT NOT NULL,
				type TEXT NOT NULL,
				start_seconds REAL NOT NULL,
				end_seconds REAL NOT NULL,
				label TEXT,
				source TEXT NOT NULL DEFAULT 'manual',
				plugin_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`),
	);
});

beforeEach(async () => {
	await client.run(sql.raw("DELETE FROM media_markers"));

	for (const [index, row] of FIXTURES.entries()) {
		await client.run(sql`
			INSERT INTO media_markers (id, media_file_id, type, start_seconds, end_seconds, label, source, plugin_id, created_at, updated_at)
			VALUES (${row.id}, ${row.mediaFileId}, ${row.type}, 0, 10, ${row.label}, ${row.source}, ${row.pluginId}, ${index}, ${index})
		`);
	}
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
		expect(idsOf(await mediaMarkersRepository.findAll({ q: "beta" }))).toEqual(["m3"]);
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

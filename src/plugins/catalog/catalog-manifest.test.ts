import { describe, expect, test } from "bun:test";
import { type PluginCatalogEntry, parsePluginCatalogManifest, resolveCatalogCandidate } from "./catalog-manifest";

const VALID_ENTRY = {
	id: "org.reelvault.tmdb",
	name: "TMDB Metadata Provider",
	version: "1.2.0",
	description: "Metadata provider backed by The Movie Database API.",
	category: "metadata",
	downloadUrl: "https://example.com/tmdb-1.2.0.zip",
	checksum: `sha256-${"0".repeat(64)}`,
};

const sha = (digit: string): string => `sha256-${digit.repeat(64)}`;

const entryWithVersions = (versions: unknown): unknown => ({
	...VALID_ENTRY,
	versions,
});

const validVersion = (version: string, digest = "1"): Record<string, string> => ({
	version,
	downloadUrl: `https://example.com/tmdb-${version}.zip`,
	checksum: sha(digest),
	date: "2026-09-01T12:00:00.000Z",
	changelog: `Release ${version}`,
});

describe("plugin catalog manifest", () => {
	test("parses a valid manifest and applies category defaults", () => {
		const manifest = parsePluginCatalogManifest(
			JSON.stringify({ apiVersion: 1, name: "ReelVault Official", plugins: [{ ...VALID_ENTRY, category: undefined }] }),
		);
		expect(manifest.name).toBe("ReelVault Official");
		expect(manifest.plugins).toHaveLength(1);
		expect(manifest.plugins[0]?.category).toBe("other");
		expect(manifest.plugins[0]?.checksum).toBe(`sha256-${"0".repeat(64)}`);
	});

	test("rejects an unsupported apiVersion", () => {
		expect(() => parsePluginCatalogManifest(JSON.stringify({ apiVersion: 2, name: "x", plugins: [] }))).toThrow("apiVersion");
	});

	test("rejects invalid JSON", () => {
		expect(() => parsePluginCatalogManifest("{not json")).toThrow("not valid JSON");
	});

	test("rejects an entry with a bad identifier", () => {
		expect(() =>
			parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [{ ...VALID_ENTRY, id: "../escape" }] })),
		).toThrow("identifier");
	});

	test("rejects an entry with a malformed checksum", () => {
		expect(() =>
			parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [{ ...VALID_ENTRY, checksum: "sha256-tooshort" }] })),
		).toThrow("checksum");
	});

	test("rejects an entry with a non-https download URL", () => {
		expect(() =>
			parsePluginCatalogManifest(
				JSON.stringify({ apiVersion: 1, name: "x", plugins: [{ ...VALID_ENTRY, downloadUrl: "file:///etc/passwd" }] }),
			),
		).toThrow("https");
	});

	test("rejects an unknown category", () => {
		expect(() =>
			parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [{ ...VALID_ENTRY, category: "games" }] })),
		).toThrow("category");
	});

	test.each([["javascript", "alert(1)"].join(":"), "data:text/html,<script>", "//evil.example.com", "file:///etc/passwd"])(
		"rejects a non-https homepage: %s",
		(homepage) => {
			expect(() =>
				parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [{ ...VALID_ENTRY, homepage }] })),
			).toThrow("homepage");
		},
	);

	test("rejects a non-https iconUrl", () => {
		expect(() =>
			parsePluginCatalogManifest(
				JSON.stringify({ apiVersion: 1, name: "x", plugins: [{ ...VALID_ENTRY, iconUrl: "data:image/png;base64,AAAA" }] }),
			),
		).toThrow("iconUrl");
	});

	test("parses a valid version history with dates and changelogs", () => {
		const manifest = parsePluginCatalogManifest(
			JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions([validVersion("1.1.0"), validVersion("1.0.0", "2")])] }),
		);
		expect(manifest.plugins[0]?.versions).toHaveLength(2);
		expect(manifest.plugins[0]?.versions?.[0]?.version).toBe("1.1.0");
		expect(manifest.plugins[0]?.versions?.[0]?.date).toBe("2026-09-01T12:00:00.000Z");
		expect(manifest.plugins[0]?.versions?.[1]?.checksum).toBe(sha("2"));
	});

	test("accepts a manifest without version history", () => {
		const manifest = parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [VALID_ENTRY] }));
		expect(manifest.plugins[0]?.versions).toBeUndefined();
	});

	test("rejects a history entry with a non-semantic version", () => {
		expect(() =>
			parsePluginCatalogManifest(
				JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions([{ ...validVersion("1.1.0"), version: "latest" }])] }),
			),
		).toThrow("semantic version");
	});

	test("rejects a history entry with a non-https download URL", () => {
		expect(() =>
			parsePluginCatalogManifest(
				JSON.stringify({
					apiVersion: 1,
					name: "x",
					plugins: [entryWithVersions([{ ...validVersion("1.1.0"), downloadUrl: "http://example.com/tmdb-1.1.0.zip" }])],
				}),
			),
		).toThrow("https");
	});

	test("rejects a history entry with a malformed checksum", () => {
		expect(() =>
			parsePluginCatalogManifest(
				JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions([{ ...validVersion("1.1.0"), checksum: "md5-abc" }])] }),
			),
		).toThrow("checksum");
	});

	test("rejects duplicate versions within the history and against the top level", () => {
		const duplicated = [validVersion("1.1.0"), validVersion("1.1.0", "2")];
		expect(() =>
			parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions(duplicated)] })),
		).toThrow("duplicate");

		const shadowingLatest = [validVersion("1.2.0"), validVersion("1.1.0", "2")];
		expect(() =>
			parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions(shadowingLatest)] })),
		).toThrow("duplicate");
	});

	test("rejects more versions than the per-plugin limit", () => {
		const versions = Array.from({ length: 51 }, (_, index) => validVersion(`0.0.${index + 1}`, `${(index % 9) + 1}`));
		expect(() => parsePluginCatalogManifest(JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions(versions)] }))).toThrow(
			"more than",
		);
	});

	test.each(["not-a-date", "2026-13-99T99:99:99Z"])("rejects an invalid date: %s", (date) => {
		expect(() =>
			parsePluginCatalogManifest(
				JSON.stringify({ apiVersion: 1, name: "x", plugins: [entryWithVersions([{ ...validVersion("1.1.0"), date }])] }),
			),
		).toThrow("date");
	});
});

describe("resolveCatalogCandidate", () => {
	const entry: PluginCatalogEntry = {
		id: "org.reelvault.tmdb",
		name: "TMDB Metadata Provider",
		version: "1.2.0",
		category: "metadata",
		downloadUrl: "https://example.com/tmdb-1.2.0.zip",
		checksum: sha("0"),
		versions: [
			{ version: "1.1.0", downloadUrl: "https://example.com/tmdb-1.1.0.zip", checksum: sha("1") },
			{ version: "1.0.0", downloadUrl: "https://example.com/tmdb-1.0.0.zip", checksum: sha("2") },
		],
	};

	test("without a version resolves to the latest entry", () => {
		const candidate = resolveCatalogCandidate([entry], "org.reelvault.tmdb", undefined);
		expect(candidate).toEqual({ id: entry.id, version: "1.2.0", downloadUrl: entry.downloadUrl, checksum: entry.checksum });
	});

	test("an explicit latest version matches the top-level entry", () => {
		const candidate = resolveCatalogCandidate([entry], "org.reelvault.tmdb", "1.2.0");
		expect(candidate?.downloadUrl).toBe(entry.downloadUrl);
	});

	test("an explicit historical version resolves from the version history", () => {
		const candidate = resolveCatalogCandidate([entry], "org.reelvault.tmdb", "1.0.0");
		expect(candidate).toEqual({ id: entry.id, version: "1.0.0", downloadUrl: "https://example.com/tmdb-1.0.0.zip", checksum: sha("2") });
	});

	test("an unknown version returns undefined", () => {
		expect(resolveCatalogCandidate([entry], "org.reelvault.tmdb", "9.9.9")).toBeUndefined();
		expect(resolveCatalogCandidate([entry], "org.reelvault.unknown", undefined)).toBeUndefined();
	});
});

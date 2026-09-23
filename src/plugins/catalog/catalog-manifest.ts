import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { ValidationError } from "@/utils/errors";
import { isNonEmptyString, isRecord } from "@/utils/type.utils";

/** The repository seeded into a fresh server so the catalog is never empty. */
export const OFFICIAL_PLUGIN_REPOSITORY = {
	name: "ReelVault Official",
	url: "https://raw.githubusercontent.com/ReelVault/plugins/main/dist/reelvault-catalog.json",
} as const;

export const PLUGIN_CATALOG_API_VERSION = 1 as const;

export const PLUGIN_CATALOG_CATEGORIES = ["metadata", "subtitles", "automation", "integrations", "ui", "other"] as const;

export type PluginCatalogCategory = (typeof PLUGIN_CATALOG_CATEGORIES)[number];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const SHA256_PATTERN = /^sha256-[a-f0-9]{64}$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_PLUGINS = 500;
const MAX_VERSIONS_PER_PLUGIN = 50;
const MAX_DATE_LENGTH = 40;
const PLUGIN_CATALOG_CATEGORY_SET: ReadonlySet<string> = new Set(PLUGIN_CATALOG_CATEGORIES);

export function isHttpsUrl(value: string): boolean {
	return value.length <= 2048 && HTTPS_URL_PATTERN.test(value);
}

export function isPluginCatalogCategory(value: string): value is PluginCatalogCategory {
	return PLUGIN_CATALOG_CATEGORY_SET.has(value);
}

/**
 * A previously published version of a plugin — same invariants as the top-level
 * entry. The top-level fields always describe the latest release; `versions[]`
 * is the installable archive for rolling back.
 */
export interface PluginCatalogVersionEntry {
	version: string;
	date?: string;
	changelog?: string;
	downloadUrl: string;
	checksum: string;
}

export interface PluginCatalogEntry {
	id: string;
	name: string;
	version: string;
	description?: string;
	category: PluginCatalogCategory;
	homepage?: string;
	iconUrl?: string;
	changelog?: string;
	downloadUrl: string;
	checksum: string;
	date?: string;
	capabilities?: string[];
	versions?: PluginCatalogVersionEntry[];
}

export interface PluginCatalogManifest {
	apiVersion: typeof PLUGIN_CATALOG_API_VERSION;
	name: string;
	plugins: PluginCatalogEntry[];
}

/** A catalog candidate narrowed to what an install needs — latest entry or a published historical version. */
export interface ResolvedCatalogCandidate {
	id: string;
	version: string;
	downloadUrl: string;
	checksum: string;
}

/**
 * Resolves the archive to install. Without an explicit version this is the
 * plugin's latest entry; a version may come from either the top-level entry or
 * its published `versions[]` history (rollback).
 */
export function resolveCatalogCandidate(
	plugins: PluginCatalogEntry[],
	pluginId: string,
	version: string | undefined,
): ResolvedCatalogCandidate | undefined {
	const toCandidate = (plugin: PluginCatalogEntry): ResolvedCatalogCandidate => ({
		id: plugin.id,
		version: plugin.version,
		downloadUrl: plugin.downloadUrl,
		checksum: plugin.checksum,
	});

	const latest = plugins.find((plugin) => plugin.id === pluginId);
	if (!version) return latest ? toCandidate(latest) : undefined;

	for (const plugin of plugins) {
		if (plugin.id !== pluginId) continue;
		if (plugin.version === version) return toCandidate(plugin);

		const archived = plugin.versions?.find((entry) => entry.version === version);
		if (archived) return { id: plugin.id, version: archived.version, downloadUrl: archived.downloadUrl, checksum: archived.checksum };
	}

	return undefined;
}

/**
 * Parses and validates a catalog manifest (`reelvault-catalog.json`).
 * Catalog entries are advisory until install time — the archive checksum is
 * verified against the download and the unpacked `plugin.json` re-validated
 * by the installer, so a lying manifest can only mislabel, not bypass.
 */
export function parsePluginCatalogManifest(raw: string): PluginCatalogManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new ValidationError("Catalog manifest is not valid JSON");
	}

	if (!isRecord(value)) throw new ValidationError("Catalog manifest must be a JSON object");

	assertVersion(value.apiVersion);
	const name = assertString(value.name, "name", 200);
	if (!Array.isArray(value.plugins)) throw new ValidationError("Catalog manifest field 'plugins' must be an array");

	if (value.plugins.length > MAX_PLUGINS) throw new ValidationError(`Catalog manifest lists more than ${MAX_PLUGINS} plugins`);

	const plugins = value.plugins.map((entry, index) => validateEntry(entry, index));

	return { apiVersion: PLUGIN_CATALOG_API_VERSION, name, plugins };
}

function assertVersion(apiVersion: unknown): void {
	if (apiVersion !== PLUGIN_CATALOG_API_VERSION) {
		throw new ValidationError(`Unsupported catalog apiVersion: ${String(apiVersion)} (expected ${PLUGIN_CATALOG_API_VERSION})`);
	}
}

function validateEntry(entry: unknown, index: number): PluginCatalogEntry {
	if (!isRecord(entry)) throw new ValidationError(`Catalog plugin #${index} must be an object`);

	const failure = (name: string): string => `Catalog plugin #${index}: invalid '${name}'`;

	const id = assertString(entry.id, failure("id"), 128);
	if (!PLUGIN_IDENTIFIER_PATTERN.test(id)) throw new ValidationError(`${failure("id")} has an unsupported identifier format`);

	const name = assertString(entry.name, failure("name"), 200);
	const version = assertString(entry.version, failure("version"), 32);
	if (!SEMVER_PATTERN.test(version)) throw new ValidationError(`${failure("version")} must be semantic version`);

	const downloadUrl = assertString(entry.downloadUrl, failure("downloadUrl"), 2048);
	if (!isHttpsUrl(downloadUrl)) throw new ValidationError(`${failure("downloadUrl")} must be an https URL`);

	const checksum = assertString(entry.checksum, failure("checksum"), 71);
	if (!SHA256_PATTERN.test(checksum)) throw new ValidationError(`${failure("checksum")} must be 'sha256-' followed by 64 hex digits`);

	const categoryValue = entry.category === undefined ? "other" : entry.category;
	if (typeof categoryValue !== "string" || !isPluginCatalogCategory(categoryValue)) {
		throw new ValidationError(`${failure("category")} must be one of: ${PLUGIN_CATALOG_CATEGORIES.join(", ")}`);
	}

	const capabilities = assertOptionalStringArray(entry.capabilities, index);
	const versions = validateVersions(entry.versions, version, index);

	return {
		id,
		name,
		version,
		category: categoryValue,
		downloadUrl,
		checksum,
		...optionalString(entry.description, "description", 1000),
		...optionalHttpsUrl(entry.homepage, "homepage"),
		...optionalHttpsUrl(entry.iconUrl, "iconUrl"),
		...optionalString(entry.changelog, "changelog", 4000),
		...optionalIsoDate(entry.date, "date"),
		...(capabilities ? { capabilities } : {}),
		...(versions ? { versions } : {}),
	};
}

/**
 * Validates the optional version history. Every entry must satisfy the same
 * invariants as the top-level entry and versions must be unique across the
 * whole plugin — including the latest version itself, which lives at the
 * top level only.
 */
function validateVersions(value: unknown, latestVersion: string, index: number): PluginCatalogVersionEntry[] | undefined {
	if (value === undefined || value === null) return undefined;

	if (!Array.isArray(value)) throw new ValidationError(`Catalog plugin #${index}: invalid 'versions' array`);

	if (value.length > MAX_VERSIONS_PER_PLUGIN) {
		throw new ValidationError(`Catalog plugin #${index}: 'versions' lists more than ${MAX_VERSIONS_PER_PLUGIN} entries`);
	}

	const seen = new Set([latestVersion]);
	const versions: PluginCatalogVersionEntry[] = [];
	for (const item of value) {
		if (!isRecord(item)) throw new ValidationError(`Catalog plugin #${index}: invalid version entry`);

		const failure = (name: string): string => `Catalog plugin #${index}: invalid version '${name}'`;

		const version = assertString(item.version, failure("version"), 32);
		if (!SEMVER_PATTERN.test(version)) throw new ValidationError(`${failure("version")} must be semantic version`);

		const downloadUrl = assertString(item.downloadUrl, failure("downloadUrl"), 2048);
		if (!isHttpsUrl(downloadUrl)) throw new ValidationError(`${failure("downloadUrl")} must be an https URL`);

		const checksum = assertString(item.checksum, failure("checksum"), 71);
		if (!SHA256_PATTERN.test(checksum)) throw new ValidationError(`${failure("checksum")} must be 'sha256-' followed by 64 hex digits`);

		if (seen.has(version)) throw new ValidationError(`Catalog plugin #${index}: duplicate version '${version}'`);
		seen.add(version);

		const parsed: PluginCatalogVersionEntry = { version, downloadUrl, checksum };
		if (item.date !== undefined && item.date !== null) {
			const date = assertString(item.date, failure("date"), MAX_DATE_LENGTH);
			if (Number.isNaN(Date.parse(date))) throw new ValidationError(`${failure("date")} must be an ISO date`);
			parsed.date = date;
		}
		if (item.changelog !== undefined && item.changelog !== null) {
			parsed.changelog = assertString(item.changelog, failure("changelog"), 4000);
		}
		versions.push(parsed);
	}

	return versions.length > 0 ? versions : undefined;
}

function optionalIsoDate(value: unknown, key: string): Partial<Record<string, string>> {
	if (value === undefined || value === null) return {};

	const date = assertString(value, key, MAX_DATE_LENGTH);
	if (Number.isNaN(Date.parse(date))) throw new ValidationError(`Catalog plugin: '${key}' must be an ISO date`);

	return { [key]: date };
}

function assertString(value: unknown, label: string, maxLength: number): string {
	if (!isNonEmptyString(value)) throw new ValidationError(`${label} must be a non-empty string`);

	if (value.length > maxLength) throw new ValidationError(`${label} exceeds ${maxLength} characters`);

	return value;
}

function optionalString(value: unknown, key: string, maxLength: number): Partial<Record<string, string>> {
	if (value === undefined || value === null) return {};

	if (typeof value !== "string" || value.length > maxLength) {
		throw new ValidationError(`Catalog plugin: invalid '${key}'`);
	}

	return { [key]: value };
}

/**
 * `homepage`/`iconUrl` end up in the admin UI as `<a href>` / `<img src>`.
 * A hostile catalog repository could otherwise inject `javascript:`/`data:`;
 * require the same https-only rule as `downloadUrl`.
 */
function optionalHttpsUrl(value: unknown, key: string): Partial<Record<string, string>> {
	const result = optionalString(value, key, 2048);
	const url = result[key];
	if (url !== undefined && !isHttpsUrl(url)) {
		throw new ValidationError(`Catalog plugin: '${key}' must be an https URL`);
	}

	return result;
}

function assertOptionalStringArray(value: unknown, index: number): string[] | undefined {
	if (value === undefined || value === null) return undefined;

	if (!Array.isArray(value)) throw new ValidationError(`Catalog plugin #${index}: invalid string array`);

	const items: string[] = [];
	for (const item of value) {
		if (!isNonEmptyString(item) || item.length > 128) {
			throw new ValidationError(`Catalog plugin #${index}: invalid string array`);
		}

		items.push(item);
	}

	return items.length > 0 ? items : undefined;
}

export { MAX_MANIFEST_BYTES as PLUGIN_CATALOG_MAX_MANIFEST_BYTES };

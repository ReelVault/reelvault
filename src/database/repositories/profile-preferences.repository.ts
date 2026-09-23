import type { ProfilePreferences, UpdateProfilePreferences } from "@sdk/common/profile-preferences.types";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
	isProfilePreferenceKey,
	PROFILE_PREFERENCE_DEFINITIONS,
	type ProfilePreferenceDefinition,
	type ProfilePreferenceKey,
} from "@/config/profile-preferences.definitions";
import { type DatabaseFactory, databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { MemoryCache } from "@/utils/memory-cache";

const OVERRIDES_CACHE_TTL_MS = 5 * MINUTE;
const OVERRIDES_CACHE_MAX_ENTRIES = 500;

export type ProfilePreferenceOverrideRows = Record<string, string>;

/** Blank audio/subtitle language means "cleared" — stored as null and never persisted. */
const NULLABLE_LANGUAGE_KEYS = new Set<string>(["audioLanguage", "subtitleLanguage"]);

type PreferenceFieldValue = string | boolean | number | null | undefined;

function normalizePreferenceValue(key: ProfilePreferenceKey, value: PreferenceFieldValue): PreferenceFieldValue {
	if (value === undefined) return undefined;

	if (NULLABLE_LANGUAGE_KEYS.has(key) && typeof value === "string" && value.trim() === "") return null;

	return value;
}

/** Layers parsed stored overrides on top of the admin-configured defaults. */
function mergePreferenceOverrides(profileId: string, overrides: ProfilePreferenceOverrideRows): ProfilePreferences {
	const parsed: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(overrides)) {
		if (!isProfilePreferenceKey(key)) continue;

		const definition: ProfilePreferenceDefinition = PROFILE_PREFERENCE_DEFINITIONS[key];
		const value = definition.parse(raw);
		if (value !== null) parsed[key] = value;
	}

	// Override rows are parsed through the per-field codecs, so the spread is
	// guaranteed to satisfy every contract field.
	const merged: ProfilePreferences = { profileId, ...serverConfig.profiles.defaultPreferences, ...parsed };

	return merged;
}

export class ProfilePreferencesRepository {
	readonly table = schema.profilePreferenceOverrides;
	private readonly database: Pick<DatabaseFactory, "getClient">;
	private readonly cache = new MemoryCache<ProfilePreferenceOverrideRows>({
		ttlMs: OVERRIDES_CACHE_TTL_MS,
		maxSize: OVERRIDES_CACHE_MAX_ENTRIES,
		name: "profile-preferences",
	});

	constructor(database: Pick<DatabaseFactory, "getClient"> = databaseFactory) {
		this.database = database;
	}

	async listByProfileId({
		profileId,
		tx,
	}: {
		profileId: string;
		tx?: DatabaseTransaction | undefined;
	}): Promise<ProfilePreferenceOverrideRows> {
		if (!tx) {
			const cached = this.cache.get(profileId);
			if (cached) return cached;
		}

		const rows = await this.database
			.getClient({ tx })
			.select({ key: this.table.key, value: this.table.value })
			.from(this.table)
			.where(eq(this.table.profileId, profileId));

		const overrides: ProfilePreferenceOverrideRows = {};
		for (const row of rows) overrides[row.key] = row.value;

		if (!tx) this.cache.set(profileId, overrides);

		return overrides;
	}

	/** Effective preferences: admin defaults layered with this profile's stored overrides. */
	async getEffective({ profileId, tx }: { profileId: string; tx?: DatabaseTransaction | undefined }): Promise<ProfilePreferences> {
		const overrides = await this.listByProfileId({ profileId, tx });

		return mergePreferenceOverrides(profileId, overrides);
	}

	/**
	 * Persists a partial delta, but only values that differ from the effective
	 * defaults — values equal to a default (or cleared languages) prune the
	 * stored override so the profile keeps inheriting admin changes.
	 */
	async applyUpdate({
		profileId,
		body,
		tx,
	}: {
		profileId: string;
		body: UpdateProfilePreferences;
		tx?: DatabaseTransaction | undefined;
	}): Promise<ProfilePreferences> {
		const defaults = serverConfig.profiles.defaultPreferences;
		const upserts: Array<{ key: string; value: string }> = [];
		const removals: string[] = [];

		for (const key of Object.keys(body)) {
			if (!isProfilePreferenceKey(key)) continue;

			const definition: ProfilePreferenceDefinition = PROFILE_PREFERENCE_DEFINITIONS[key];
			const value = normalizePreferenceValue(key, body[key]);
			if (value === undefined) continue;

			if (value === null || value === defaults[key]) removals.push(key);
			else upserts.push({ key, value: definition.serialize(value) });
		}

		await this.deleteMany({ profileId, keys: removals, tx });
		await this.setMany({ profileId, entries: upserts, tx });

		return await this.getEffective({ profileId, tx });
	}

	/** Removes all stored overrides — the profile falls back to the admin defaults. */
	async reset({ profileId, tx }: { profileId: string; tx?: DatabaseTransaction | undefined }): Promise<ProfilePreferences> {
		await this.database.getClient({ tx }).delete(this.table).where(eq(this.table.profileId, profileId));
		this.cache.delete(profileId);

		return await this.getEffective({ profileId, tx });
	}

	private async setMany({
		profileId,
		entries,
		tx,
	}: {
		profileId: string;
		entries: Array<{ key: string; value: string }>;
		tx?: DatabaseTransaction | undefined;
	}): Promise<void> {
		if (entries.length === 0) return;

		const now = new Date();
		await this.database
			.getClient({ tx })
			.insert(this.table)
			.values(entries.map((entry) => ({ profileId, key: entry.key, value: entry.value, createdAt: now, updatedAt: now })))
			.onConflictDoUpdate({
				target: [this.table.profileId, this.table.key],
				set: { value: sql`excluded.value`, updatedAt: now },
			});
		this.cache.delete(profileId);
	}

	private async deleteMany({
		profileId,
		keys,
		tx,
	}: {
		profileId: string;
		keys: string[];
		tx?: DatabaseTransaction | undefined;
	}): Promise<void> {
		if (keys.length === 0) return;

		await this.database
			.getClient({ tx })
			.delete(this.table)
			.where(and(eq(this.table.profileId, profileId), inArray(this.table.key, keys)));
		this.cache.delete(profileId);
	}
}

export const profilePreferencesRepository = new ProfilePreferencesRepository();

import type { ImportSystemSettings, SystemSettingsExport } from "@reelvault/sdk/common";
import { libraryWatcherService } from "@/application/libraries/watching/library-watcher.service";
import {
	isSystemSettingKey,
	SETTING_KEYS,
	SYSTEM_SETTINGS,
	type SystemSettingKey,
	type SystemSettingValue,
} from "@/config/system-settings.definition";
import { serializeSettingValue, systemSettingsStore } from "@/config/system-settings.store";
import type { SettingGroup } from "@/config/system-settings.types";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { type SystemSettingRow, systemSettingsRepository } from "@/database/repositories/system-settings.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { initializeFfmpegCapabilities } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { assertFFMpegAvailable } from "@/integrations/ffmpeg/ffmpeg.environment";
import { clearFFProbeCache } from "@/integrations/ffprobe/ffprobe.builder";
import { assertFFProbeAvailable } from "@/integrations/ffprobe/ffprobe.environment";
import { rateLimitOverrideIssues } from "@/middleware/rate-limit-overrides";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { serverConfig } from "@/server.config";
import { resourceAllocator } from "@/system/resource-allocator";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { setLogLevel } from "@/utils/logger";
import { invalidateResponseBodies } from "@/utils/response-body-cache";
import { recordAuditSafe } from "./admin-audit.service";

interface SystemSettingItemView {
	key: string;
	group: SettingGroup;
	type: string;
	value: unknown;
	default: unknown;
	options?: string[];
	isCustom: boolean;
	/** When a custom value was last saved; absent for defaults. */
	updatedAt?: string;
	/** The administrator who saved the custom value (null when none is known). */
	lastModifiedBy?: string | null;
}

class SystemSettingsService extends BaseService {
	private isInitialized = false;
	// Dedupes concurrent ensureInitialized() calls: without it two parallel requests
	// would run repository.list() + populateCache() twice before the first init() finished.
	private initPromise: Promise<void> | null = null;

	constructor() {
		super("SystemSettingsService");
	}

	init(): Promise<void> {
		if (this.isInitialized) return Promise.resolve();

		this.initPromise ??= this.runInit();

		return this.initPromise;
	}

	private async runInit(): Promise<void> {
		try {
			const rows = await systemSettingsRepository.list();
			this.populateCache(rows);
			this.isInitialized = true;
			this.logger.info("System settings initialized from database", { count: rows.length });
		} catch (error) {
			this.logger.warn("Could not load system settings from database, using defaults", { error });
		} finally {
			// Lets the next ensureInitialized() retry if init() failed.
			this.initPromise = null;
		}
	}

	private populateCache(rows: SystemSettingRow[]): void {
		systemSettingsStore.clearRuntimeValues();
		for (const row of rows) {
			if (!isSystemSettingKey(row.key)) continue;

			try {
				systemSettingsStore.setParsedRuntimeValue(row.key, SYSTEM_SETTINGS[row.key].parse(row.value));
			} catch (error) {
				this.logger.warn("Failed to parse setting value, using default", { key: row.key, error });
			}
		}
	}

	get<K extends SystemSettingKey>(key: K): SystemSettingValue<K> {
		return systemSettingsStore.get(key);
	}

	async getAll(): Promise<Record<SettingGroup, SystemSettingItemView[]>> {
		await this.ensureInitialized();
		const rowsByKey = new Map((await systemSettingsRepository.list()).map((row) => [row.key, row]));

		const grouped: Record<SettingGroup, SystemSettingItemView[]> = {
			resources: [],
			downloads: [],
			streaming: [],
			scanning: [],
			markers: [],
			trickplay: [],
			images: [],
			workers: [],
			playback_defaults: [],
			system: [],
			network: [],
		};

		for (const key of SETTING_KEYS) {
			const def = SYSTEM_SETTINGS[key];
			const { value, isCustom } = systemSettingsStore.getWithMeta(key);

			const row = rowsByKey.get(key);
			grouped[def.group].push({
				key,
				group: def.group,
				type: def.type,
				value,
				...(row ? { updatedAt: new Date(row.updatedAt).toISOString(), lastModifiedBy: row.lastModifiedBy } : {}),
				default: def.default,
				isCustom,
				...(def.options ? { options: def.options } : {}),
				...(def.min !== undefined ? { min: def.min } : {}),
				...(def.max !== undefined ? { max: def.max } : {}),
				...(def.unit !== undefined ? { unit: def.unit } : {}),
				...(def.restartRequired ? { restartRequired: true } : {}),
			});
		}

		return grouped;
	}

	/** Every setting's current value, versioned so an import can refuse any other format. */
	async exportSettings(): Promise<SystemSettingsExport> {
		await this.ensureInitialized();

		const settings: Record<string, unknown> = {};
		for (const key of SETTING_KEYS) settings[key] = systemSettingsStore.get(key);

		return { format: "reelvault.settings", formatVersion: 1, exportedAt: new Date().toISOString(), settings };
	}

	/** Goes through the same validation as a manual update, so one unknown key or invalid value refuses the whole file. */
	async importSettings(body: ImportSystemSettings, context?: AdminAuditContext) {
		return await this.updateSettings(body.settings, context);
	}

	private parseAndSerialize<K extends SystemSettingKey>(
		key: K,
		rawValue: unknown,
	): { parsedValue: SystemSettingValue<K>; finalSerialized: string } {
		const def = SYSTEM_SETTINGS[key];
		// Strict validation: an invalid client value must fail the request instead
		// of silently persisting the definition default over the configured value.
		const parsedValue = def.validate(serializeSettingValue(rawValue));
		if (parsedValue === null) {
			throw new ValidationError(`Invalid value for setting "${key}"`, {
				code: "admin.settings.invalid_value",
				params: { key, ...(def.min !== undefined ? { min: def.min } : {}), ...(def.max !== undefined ? { max: def.max } : {}) },
			});
		}

		return { parsedValue, finalSerialized: def.serialize(parsedValue) };
	}

	async updateSettings(
		updates: Record<string, unknown>,
		context?: AdminAuditContext,
	): Promise<Record<SettingGroup, SystemSettingItemView[]>> {
		await this.ensureInitialized();

		const dbEntries: Array<{ key: string; value: string }> = [];
		const prunedKeys: SystemSettingKey[] = [];
		const beforeValues: Record<string, unknown> = {};
		const afterValues = new Map<SystemSettingKey, SystemSettingValue<SystemSettingKey>>();

		for (const [key, rawValue] of Object.entries(updates)) {
			// A stale or misspelled key used to be dropped silently, so the admin saw "saved" for a setting that never changed.
			if (!isSystemSettingKey(key)) {
				throw new ValidationError(`Unknown setting "${key}"`, { code: "admin.settings.unknown_key", params: { key } });
			}

			const { parsedValue, finalSerialized } = this.parseAndSerialize(key, rawValue);

			// A route budget override must name tunable buckets with whole numbers, or the limiter would ignore it silently.
			if (key === "network.rateLimit.routeOverrides") {
				const issues = rateLimitOverrideIssues(String(parsedValue));
				if (issues.malformed.length > 0 || issues.untunable.length > 0) {
					throw new ValidationError("Route budget overrides must be name=max pairs for tunable routes", {
						code: "network.rate_limit_override_invalid",
						params: { malformed: issues.malformed.join(", "), untunable: issues.untunable.join(", ") },
					});
				}
			}

			// Enforcement signs out accounts without an authenticator, so it stays off until an administrator has one.
			if (key === "auth.enforceTwoFactor" && parsedValue === true && (await usersRepository.countAdministratorsWithTwoFactor()) === 0) {
				throw new ValidationError("Two-factor enforcement needs at least one administrator with two-factor authentication enabled", {
					code: "auth.two_factor_requires_admin",
				});
			}

			// Record "before" only after successful parsing — the audit must contain real changes only.
			beforeValues[key] = systemSettingsStore.getWithMeta(key).value;
			afterValues.set(key, parsedValue);

			// Saving the definition default drops the override instead of persisting it:
			// a stored default shadows env-based fallbacks (APP_FFMPEG_PATH) and survives resets.
			if (isDefaultSettingValue(SYSTEM_SETTINGS[key].default, parsedValue)) {
				prunedKeys.push(key);
				continue;
			}

			dbEntries.push({ key, value: finalSerialized });
		}

		// Cross-field rules are checked against the resulting effective config and
		// reject the whole batch before anything is persisted or mutated.
		assertCrossFieldSettings(updates, afterValues);

		if (dbEntries.length > 0 || prunedKeys.length > 0) {
			// Persist first: a failed write must not leave the runtime overrides
			// diverged from what is actually stored.
			if (dbEntries.length > 0)
				await systemSettingsRepository.setMany(dbEntries.map((entry) => ({ ...entry, lastModifiedBy: context?.actorUserId ?? null })));
			if (prunedKeys.length > 0) await systemSettingsRepository.deleteMany(prunedKeys);
			for (const [key, value] of afterValues.entries()) {
				if (prunedKeys.includes(key)) continue;

				systemSettingsStore.setParsedRuntimeValue(key, value);
			}

			if (prunedKeys.length > 0) systemSettingsStore.deleteRuntimeValues(prunedKeys);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "system_settings",
					resourceId: "system",
					before: beforeValues,
					// A Map serializes to `{}` — the audit trail must carry real values.
					after: Object.fromEntries(afterValues),
					context: {
						actorUserId: context?.actorUserId,
						headers: context?.headers,
					},
				},
				this.logger,
			);

			const changedKeys = [...afterValues.keys()];
			this.logger.info("Updated system settings", { keys: changedKeys });
			this.broadcastChange(changedKeys, context?.actorUserId);

			await this.applySettingsSideEffects(changedKeys);
		}

		return await this.getAll();
	}

	async resetSettings(keys?: string[], context?: AdminAuditContext): Promise<Record<SettingGroup, SystemSettingItemView[]>> {
		await this.ensureInitialized();

		const keysToReset = keys && keys.length > 0 ? keys.filter((item) => isSystemSettingKey(item)) : [...SETTING_KEYS];

		const beforeValues: Record<string, unknown> = {};
		for (const key of keysToReset) {
			const { value, isCustom } = systemSettingsStore.getWithMeta(key);
			if (isCustom) beforeValues[key] = value;
		}

		if (keysToReset.length > 0) {
			// Persist the reset before dropping runtime overrides — a failed delete
			// must not leave the runtime using defaults the DB still overrides.
			await systemSettingsRepository.deleteMany(keysToReset);
			systemSettingsStore.deleteRuntimeValues(keysToReset);

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "system_settings",
					resourceId: "reset",
					before: beforeValues,
					after: { resetKeys: keysToReset },
					context: {
						actorUserId: context?.actorUserId,
						headers: context?.headers,
					},
				},
				this.logger,
			);

			this.logger.info("Reset system settings to defaults", { keys: keysToReset });
			this.broadcastChange(keysToReset, context?.actorUserId);

			await this.applySettingsSideEffects(keysToReset);
		}

		return await this.getAll();
	}

	/**
	 * Runtime side effects a settings write requires (watcher re-sync, FFmpeg
	 * reload, log level). Always runs after persistence, so a failed write never
	 * triggers them; the same key rules apply to updates and resets.
	 */
	/** Tells the other administrator sessions which settings changed, so their open pages reload them. */
	private broadcastChange(keys: readonly string[], actorUserId: string | undefined): void {
		realtimeService.broadcastToAdmins("settings:changed", {
			keys: [...keys],
			actorUserId,
			updatedAt: new Date().toISOString(),
		});
	}

	private async applySettingsSideEffects(keys: readonly string[]): Promise<void> {
		let needsWatcherSync = false;
		let needsFfmpegReload = false;
		let changesProfileDefaults = false;
		let changesLogLevel = false;
		let changesProviderCacheTtl = false;
		let changesMonitoring = false;
		for (const key of keys) {
			// The watcher reads its fallback interval when arming timers, so a change
			// must re-arm them; the same applies to the periodic rescan deadline.
			if (
				key.startsWith("scanning.autoWatcher") ||
				key === "scanning.watcherFallbackIntervalMinutes" ||
				key === "scanning.scheduledScanIntervalHours"
			) {
				needsWatcherSync = true;
			}

			if (key.startsWith("profiles.defaultPreferences.")) changesProfileDefaults = true;

			if (key.startsWith("ffmpeg.") || key === "ffprobe.path") needsFfmpegReload = true;

			if (key === "system.logs.level") changesLogLevel = true;

			if (key === "plugins.providers.detailsCacheTtlMs") changesProviderCacheTtl = true;

			if (key === "system.resources.monitoringIntervalMs" || key === "system.resources.monitoringEnabled") changesMonitoring = true;
		}

		// Profiles inherit these defaults; any cached response that embeds effective preferences is stale now.
		if (changesProfileDefaults) invalidateResponseBodies();

		// The stored level overrides LOG_LEVEL from here on; the debug file still requires a restart.
		if (changesLogLevel) setLogLevel(serverConfig.logs.level);

		if (changesProviderCacheTtl) providerService.resetCaches();

		if (changesMonitoring) resourceAllocator.rescheduleMonitoring();

		if (needsWatcherSync) await libraryWatcherService.syncWatchers();

		if (needsFfmpegReload) await this.reloadFfmpeg();
	}

	private async reloadFfmpeg(): Promise<void> {
		try {
			assertFFMpegAvailable();
			await initializeFfmpegCapabilities();
			assertFFProbeAvailable();
			clearFFProbeCache();
			this.logger.info("Refreshed FFmpeg and FFprobe configurations");
		} catch (error) {
			this.logger.warn("Could not reload FFmpeg / FFprobe capabilities after settings update", { error });
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
	}
}

export const systemSettingsService = new SystemSettingsService();

/**
 * Cross-field rules the per-setting `parse` (single value + range) cannot express.
 * Only runs when one of the involved keys is part of the update, so a legacy
 * inconsistent DB state does not block unrelated edits.
 */
function assertCrossFieldSettings(updates: Record<string, unknown>, afterValues: Map<SystemSettingKey, unknown>): void {
	const getEffectiveNumber = (key: SystemSettingKey): number => {
		const updated = afterValues.get(key);
		if (typeof updated === "number") return updated;

		const current = systemSettingsStore.get(key);

		return typeof current === "number" ? current : 0;
	};

	if ("system.resources.memoryThresholdPercent" in updates || "system.resources.memoryCriticalPercent" in updates) {
		const threshold = getEffectiveNumber("system.resources.memoryThresholdPercent");
		const critical = getEffectiveNumber("system.resources.memoryCriticalPercent");
		if (threshold >= critical) {
			throw new ValidationError("memoryThresholdPercent must be lower than memoryCriticalPercent", {
				code: "settings.memory_threshold_order",
				params: { threshold, critical },
			});
		}
	}

	if ("stream.maxSessions" in updates || "stream.maxSessionsPerUser" in updates) {
		const maxSessions = getEffectiveNumber("stream.maxSessions");
		const maxSessionsPerUser = getEffectiveNumber("stream.maxSessionsPerUser");
		if (maxSessionsPerUser > maxSessions) {
			throw new ValidationError("maxSessionsPerUser must not exceed maxSessions", {
				code: "settings.max_sessions_order",
				params: { maxSessions, maxSessionsPerUser },
			});
		}
	}
}

/** Deep equality for the primitive and string-array values settings use. */
function isDefaultSettingValue(defaultValue: unknown, value: unknown): boolean {
	if (Array.isArray(defaultValue) || Array.isArray(value)) {
		return (
			Array.isArray(defaultValue) &&
			Array.isArray(value) &&
			defaultValue.length === value.length &&
			defaultValue.every((item, index) => item === value[index])
		);
	}

	return defaultValue === value;
}

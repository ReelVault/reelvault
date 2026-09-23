import { libraryWatcherService } from "@/application/libraries/watching/library-watcher.service";
import {
	isSystemSettingKey,
	SETTING_KEYS,
	SYSTEM_SETTINGS,
	type SystemSettingKey,
	type SystemSettingValue,
} from "@/config/system-settings.definition";
import { systemSettingsStore } from "@/config/system-settings.store";
import type { SettingGroup } from "@/config/system-settings.types";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { type SystemSettingRow, systemSettingsRepository } from "@/database/repositories/system-settings.repository";
import { initializeFfmpegCapabilities } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { assertFFMpegAvailable } from "@/integrations/ffmpeg/ffmpeg.environment";
import { clearFFProbeCache } from "@/integrations/ffprobe/ffprobe.builder";
import { assertFFProbeAvailable } from "@/integrations/ffprobe/ffprobe.environment";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { recordAuditSafe } from "./admin-audit.service";

interface SystemSettingItemView {
	key: string;
	group: SettingGroup;
	type: string;
	value: unknown;
	default: unknown;
	options?: string[];
	isCustom: boolean;
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

			const def = SYSTEM_SETTINGS[row.key];

			try {
				const parsed = def.parse(row.value);
				systemSettingsStore.setRuntimeValue(row.key, parsed);
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

			grouped[def.group].push({
				key,
				group: def.group,
				type: def.type,
				value,
				default: def.default,
				isCustom,
				...(def.options ? { options: def.options } : {}),
			});
		}

		return grouped;
	}

	private parseAndSerialize<K extends SystemSettingKey>(
		key: K,
		rawValue: unknown,
	): { parsedValue: SystemSettingValue<K>; finalSerialized: string } {
		const def = SYSTEM_SETTINGS[key];
		let serialized: string;
		if (typeof rawValue === "string") serialized = rawValue;
		else if (Array.isArray(rawValue)) serialized = JSON.stringify(rawValue);
		else serialized = String(rawValue);

		const parsedValue = def.parse(serialized);
		const finalSerialized = def.serialize(parsedValue);

		return { parsedValue, finalSerialized };
	}

	async updateSettings(
		updates: Record<string, unknown>,
		context?: AdminAuditContext,
	): Promise<Record<SettingGroup, SystemSettingItemView[]>> {
		await this.ensureInitialized();

		const dbEntries: Array<{ key: string; value: string }> = [];
		const beforeValues: Record<string, unknown> = {};
		const afterValues = new Map<SystemSettingKey, unknown>();

		for (const [key, rawValue] of Object.entries(updates)) {
			if (!isSystemSettingKey(key)) continue;

			try {
				const { parsedValue, finalSerialized } = this.parseAndSerialize(key, rawValue);

				// Record "before" only after successful parsing — the audit must contain real changes only.
				beforeValues[key] = systemSettingsStore.getWithMeta(key).value;

				dbEntries.push({ key, value: finalSerialized });
				afterValues.set(key, parsedValue);
			} catch (error) {
				this.logger.warn("Invalid value for setting, skipping", { key, value: rawValue, error });
			}
		}

		// Cross-field rules are checked against the resulting effective config and
		// reject the whole batch before anything is persisted or mutated.
		assertCrossFieldSettings(updates, afterValues);

		if (dbEntries.length > 0) {
			// Persist first: a failed write must not leave the runtime overrides
			// diverged from what is actually stored.
			await systemSettingsRepository.setMany(dbEntries);
			for (const [key, value] of afterValues.entries()) {
				systemSettingsStore.setRuntimeValue(key, value);
			}

			recordAuditSafe(
				{
					action: "update",
					resourceType: "system_settings",
					resourceId: "system",
					before: beforeValues,
					after: afterValues,
					context: {
						actorUserId: context?.actorUserId,
						headers: context?.headers,
					},
				},
				this.logger,
			);

			const changedKeys = [...afterValues.keys()];
			this.logger.info("Updated system settings", { keys: changedKeys });

			let needsWatcherSync = false;
			let needsFfmpegReload = false;
			for (const key of changedKeys) {
				if (key.startsWith("scanning.autoWatcher")) needsWatcherSync = true;

				if (key.startsWith("ffmpeg.") || key === "ffprobe.path") needsFfmpegReload = true;
			}

			if (needsWatcherSync) await libraryWatcherService.syncWatchers();

			if (needsFfmpegReload) await this.reloadFfmpeg();
		}

		return this.getAll();
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

			let needsWatcherSync = false;
			let needsFfmpegReload = false;
			for (const key of keysToReset) {
				if (key.startsWith("scanning.autoWatcher")) needsWatcherSync = true;

				if (key.startsWith("ffmpeg.") || key === "ffprobe.path") needsFfmpegReload = true;
			}

			if (needsWatcherSync) await libraryWatcherService.syncWatchers();

			if (needsFfmpegReload) await this.reloadFfmpeg();
		}

		return await this.getAll();
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

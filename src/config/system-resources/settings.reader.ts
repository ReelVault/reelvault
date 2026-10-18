import { systemSettingsStore } from "@/config/system-settings.store";
import type { CpuProfile } from "@/config/system-settings.types";
import { isFiniteNumber, isNonEmptyString } from "@/utils/type.utils";

const CPU_PROFILES = new Set<string>(["conservative", "balanced", "performance", "custom"]);

export interface CpuSettings {
	readonly cpuProfile: CpuProfile;
	readonly maxCores: number | undefined;
	readonly reservedWebCores: number | undefined;
	readonly ffmpegThreads: number | undefined;
	readonly poolMaxConcurrent: number | undefined;
}

/** Parses a setting into a positive finite number, or returns undefined.
 * Accepts both numbers (runtime store keeps parsed values) and numeric
 * strings (wire format) — a number-only check silently dropped every
 * admin override, and a string-only check would drop runtime values. */
export function readPositiveNumber(raw: unknown): number | undefined {
	let value = Number.NaN;
	if (typeof raw === "number") {
		value = raw;
	} else if (isNonEmptyString(raw)) {
		value = Number(raw);
	}

	return isFiniteNumber(value) && value > 0 ? value : undefined;
}

export function isReservedProfile(value: CpuProfile): value is Exclude<CpuProfile, "custom"> {
	return isCpuProfile(value) && value !== "custom";
}

function isCpuProfile(value: string): value is CpuProfile {
	return CPU_PROFILES.has(value);
}

function readCpuProfile(raw: unknown): CpuProfile {
	return typeof raw === "string" && isCpuProfile(raw) ? raw : "balanced";
}

/** The admin CPU settings, read from the store. Unset or invalid values come back as undefined. */
export function readCpuSettings(): CpuSettings {
	return {
		cpuProfile: readCpuProfile(systemSettingsStore.get("system.resources.cpuProfile")),
		maxCores: readPositiveNumber(systemSettingsStore.get("system.resources.maxCpuCores")),
		reservedWebCores: readPositiveNumber(systemSettingsStore.get("system.resources.reservedCoresForWeb")),
		ffmpegThreads: readPositiveNumber(systemSettingsStore.get("system.resources.ffmpegMaxThreads")),
		poolMaxConcurrent: readPositiveNumber(systemSettingsStore.get("system.resources.workerPoolMaxConcurrent")),
	};
}

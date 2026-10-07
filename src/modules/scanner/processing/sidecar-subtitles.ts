import { readdir } from "node:fs/promises";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { FileUtils } from "@/utils/file.utils";
import { LANGUAGE_TAG_PATTERN } from "@/utils/language.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";

export const SIDECAR_SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa"]);

/**
 * Season packs import one subtitle set per episode from the same directory;
 * re-reading the listing per episode is pure overhead. Short TTL: a subtitle
 * dropped in mid-scan is picked up by the next scan/refresh (imports are
 * idempotent).
 */
const DIRECTORY_LISTING_TTL_MS = 5_000;
const directoryListingCache = new MemoryCache<string[]>({
	ttlMs: DIRECTORY_LISTING_TTL_MS,
	maxSize: 64,
	name: "sidecar-subtitle-listings",
});

async function readDirectoryEntries(directory: string): Promise<string[]> {
	const cached = directoryListingCache.get(directory);
	if (cached) return cached;

	try {
		const entries = await readdir(directory);
		directoryListingCache.set(directory, entries);

		return entries;
	} catch {
		return [];
	}
}

export interface SidecarSubtitleCandidate {
	filePath: string;
	language: string;
	format: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
}

const HEARING_IMPAIRED_TOKENS = new Set(["cc", "sdh", "hi"]);

export interface ParsedSubtitleTokens {
	extension: string;
	language?: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
}

/**
 * Recognizes "<videoBase>[.<lang>][.<flag>...].<ext>" sidecar names. The video
 * base must match exactly (case-insensitive), so a sibling subtitle for another
 * episode is never attached by mistake.
 */
export function parseSidecarSubtitleName(videoBase: string, fileName: string): ParsedSubtitleTokens | null {
	return parseSidecarSubtitleNameFromBase(videoBase.toLowerCase(), fileName);
}

/** Variant for directory walks that already lower-cased the video base once. */
function parseSidecarSubtitleNameFromBase(base: string, fileName: string): ParsedSubtitleTokens | null {
	const extension = PathUtils.getExtension(fileName).slice(1);
	if (!SIDECAR_SUBTITLE_EXTENSIONS.has(extension)) return null;

	const stem = PathUtils.getFileNameWithoutExt(fileName);
	if (!stem.toLowerCase().startsWith(base)) return null;

	const rest = stem.slice(base.length);
	if (rest.length > 0 && !rest.startsWith(".")) return null;

	const tokens = rest.toLowerCase().split(".").filter(Boolean);
	const parsed: ParsedSubtitleTokens = { extension, isDefault: false, isForced: false, isHearingImpaired: false };

	for (const token of tokens) {
		const normalizedToken = token.replaceAll("_", "-");
		if (token === "default") parsed.isDefault = true;
		else if (token === "forced") parsed.isForced = true;
		else if (HEARING_IMPAIRED_TOKENS.has(token)) parsed.isHearingImpaired = true;
		else if (!parsed.language && LANGUAGE_TAG_PATTERN.test(normalizedToken)) parsed.language = normalizedToken;
		else return null;
	}

	return parsed;
}

export async function findSidecarSubtitles(videoFilePath: string): Promise<SidecarSubtitleCandidate[]> {
	const directory = PathUtils.getDirName(videoFilePath);
	const baseLower = PathUtils.getFileNameWithoutExt(videoFilePath).toLowerCase();
	const entries = await readDirectoryEntries(directory);

	const candidates: SidecarSubtitleCandidate[] = [];
	for (const entry of entries) {
		const parsed = parseSidecarSubtitleNameFromBase(baseLower, entry);
		if (!parsed) continue;

		candidates.push({
			filePath: PathUtils.join(directory, entry),
			language: parsed.language ?? "und",
			format: parsed.extension,
			isDefault: parsed.isDefault,
			isForced: parsed.isForced,
			isHearingImpaired: parsed.isHearingImpaired,
		});
	}

	const existing = await Promise.all(
		candidates.map(async (candidate) => ((await FileUtils.exists(candidate.filePath)) ? candidate : null)),
	);

	// The directory listing is cached for a short TTL — a subtitle deleted within
	// that window must not be imported as a dangling row.
	return existing
		.filter((candidate): candidate is SidecarSubtitleCandidate => candidate !== null)
		.toSorted((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * Idempotent: a language already imported for this media file wins (first file
 * alphabetically), because the external-unique index keys (mediaFileId,
 * language, type) — two same-language files would otherwise collide. One
 * existence probe plus one bulk insert replace the per-candidate SELECT+INSERT.
 */
export async function importSidecarSubtitles(mediaFileId: string, videoFilePath: string) {
	const candidates = await findSidecarSubtitles(videoFilePath);
	if (candidates.length === 0) return 0;

	const seen = await subtitlesRepository.findExternalLanguagesByMediaFile(mediaFileId);
	const missing = candidates.filter((candidate) => {
		if (seen.has(candidate.language)) return false;
		seen.add(candidate.language);

		return true;
	});
	if (missing.length === 0) return 0;

	const inserted = await subtitlesRepository.insertReturning({
		values: missing.map((candidate) => ({
			mediaFileId,
			language: candidate.language,
			format: candidate.format,
			filePath: candidate.filePath,
			type: "external",
			isDefault: candidate.isDefault,
			isForced: candidate.isForced,
			isHearingImpaired: candidate.isHearingImpaired,
		})),
		onConflict: "doNothing",
	});

	return inserted.length;
}

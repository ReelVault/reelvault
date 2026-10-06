import { readdir } from "node:fs/promises";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { LANGUAGE_TAG_PATTERN } from "@/utils/language.utils";
import { PathUtils } from "@/utils/path.utils";

export const SIDECAR_SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa"]);

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
	const extension = PathUtils.getExtension(fileName).slice(1);
	if (!SIDECAR_SUBTITLE_EXTENSIONS.has(extension)) return null;

	const stem = PathUtils.getFileNameWithoutExt(fileName);
	const base = videoBase.toLowerCase();
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
	const videoBase = PathUtils.getFileNameWithoutExt(videoFilePath);

	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch {
		return [];
	}

	const candidates: SidecarSubtitleCandidate[] = [];
	for (const entry of entries) {
		const parsed = parseSidecarSubtitleName(videoBase, entry);
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

	return candidates.toSorted((a, b) => a.filePath.localeCompare(b.filePath));
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

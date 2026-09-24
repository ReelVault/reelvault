import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";

export const SIDECAR_SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa"]);

export interface SidecarSubtitleCandidate {
	filePath: string;
	language: string;
	format: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
}

const LANGUAGE_TOKEN_PATTERN = /^[a-z]{2,3}(?:[-_][a-z]{2})?$/;
const HEARING_IMPAIRED_TOKENS = new Set(["cc", "sdh", "hi"]);
const VIDEO_BASE_EXTENSION_PATTERN = /\.[^.]+$/;

export interface ParsedSubtitleTokens {
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
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0) return null;

	const extension = fileName.slice(dot + 1).toLowerCase();
	if (!SIDECAR_SUBTITLE_EXTENSIONS.has(extension)) return null;

	const stem = fileName.slice(0, dot);
	const base = videoBase.toLowerCase();
	if (!stem.toLowerCase().startsWith(base)) return null;

	const rest = stem.slice(base.length);
	if (rest.length > 0 && !rest.startsWith(".")) return null;

	const tokens = rest.toLowerCase().split(".").filter(Boolean);
	const parsed: ParsedSubtitleTokens = { isDefault: false, isForced: false, isHearingImpaired: false };

	for (const token of tokens) {
		if (token === "default") parsed.isDefault = true;
		else if (token === "forced") parsed.isForced = true;
		else if (HEARING_IMPAIRED_TOKENS.has(token)) parsed.isHearingImpaired = true;
		else if (!parsed.language && LANGUAGE_TOKEN_PATTERN.test(token)) parsed.language = token.replaceAll("_", "-");
		else return null;
	}

	return parsed;
}

export async function findSidecarSubtitles(videoFilePath: string): Promise<SidecarSubtitleCandidate[]> {
	const directory = dirname(videoFilePath);
	const videoBase = basename(videoFilePath).replace(VIDEO_BASE_EXTENSION_PATTERN, "");

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
			filePath: join(directory, entry),
			language: parsed.language ?? "und",
			format: entry.slice(entry.lastIndexOf(".") + 1).toLowerCase(),
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
 * language, type) — two same-language files would otherwise collide.
 */
export async function importSidecarSubtitles(mediaFileId: string, videoFilePath: string) {
	const candidates = await findSidecarSubtitles(videoFilePath);
	if (candidates.length === 0) return 0;

	let imported = 0;
	for (const candidate of candidates) {
		const existing = await subtitlesRepository.findExternalByMediaFileAndLanguage({
			mediaFileId,
			language: candidate.language,
		});
		if (existing) continue;

		await subtitlesRepository.createAndRead(
			{
				mediaFileId,
				language: candidate.language,
				format: candidate.format,
				sourcePath: candidate.filePath,
				isDefault: candidate.isDefault,
				isForced: candidate.isForced,
				isHearingImpaired: candidate.isHearingImpaired,
			},
			"external",
		);
		imported += 1;
	}

	return imported;
}

import type { MediaFileAuditItem, MediaFileAuditReason, MediaFileAuditResponse } from "@reelvault/sdk/common";
import { systemSettingsStore } from "@/config/system-settings.store";
import { recognitionService } from "@/modules/recognition/recognition.service";
import { parseFileName } from "@/modules/recognition/utils/recognition.utils";
import { type MediaFileAuditRow, mediaRepository } from "@/repositories/media-files.repository";
import { extractYear } from "@/utils/media-match/normalize.utils";
import { rankCandidates } from "@/utils/media-match/ranking.utils";
import { isSequelMismatch, REVIEW_MATCH_SCORE } from "@/utils/media-match/score.constants";
import { mapLibraryType } from "@/utils/media-metadata.utils";

const SEVERITY_WEIGHTS: Record<string, number> = { high: 3, low: 1, medium: 2 };

/**
 * Scans every media file and returns the full audit report. Shared by the
 * `/media-files/audit` queued worker and any in-process caller — pages the DB
 * scan and yields between pages so the event loop is never starved.
 */
export async function buildMediaFileAuditReport(): Promise<MediaFileAuditResponse> {
	const suspects: MediaFileAuditItem[] = [];
	const totalFilesChecked = await mediaRepository.scanAuditRows(async (rows) => {
		for (const row of rows) {
			const suspect = auditMediaFileRow(row);
			if (suspect) suspects.push(suspect);
		}

		await Bun.sleep(0);
	});

	return {
		totalFilesChecked,
		suspectCount: suspects.length,
		suspects: sortAuditSuspects(suspects),
	};
}

interface RecognizedIdentity {
	title: string;
	year: number | null;
	season: number | null;
	episode: number | null;
}

function recognizeMediaFile(row: MediaFileAuditRow): RecognizedIdentity {
	const recognizedResult = recognitionService.recognize(row.filePath);
	const fallbackParsed = parseFileName(row.fileName);

	return {
		title: recognizedResult?.identity.title ?? fallbackParsed?.title ?? row.fileName,
		year: recognizedResult?.identity.year ?? fallbackParsed?.year ?? null,
		season: recognizedResult?.identity.season ?? fallbackParsed?.season ?? null,
		episode: recognizedResult?.identity.episode ?? fallbackParsed?.episode ?? null,
	};
}

/** Year drift against the assigned release date: 3+ years is high severity, 2 is medium. */
function yearMismatchReason(recognizedYear: number, releaseDate: string): MediaFileAuditReason | null {
	const assignedYear = extractYear(releaseDate);
	if (assignedYear === undefined) return null;

	const yearDiff = Math.abs(recognizedYear - assignedYear);
	if (yearDiff < 2) return null;

	return {
		code: "year_mismatch",
		severity: yearDiff >= 3 ? "high" : "medium",
		params: { recognizedYear, assignedYear, diff: yearDiff },
	};
}

/** TV-only: episode and season numbers that disagree with the assigned ones. */
function tvNumberReasons(row: MediaFileAuditRow, recognized: RecognizedIdentity): MediaFileAuditReason[] {
	const reasons: MediaFileAuditReason[] = [];

	if (recognized.episode !== null && row.episodeNumber !== null && recognized.episode !== row.episodeNumber) {
		reasons.push({
			code: "episode_mismatch",
			severity: "high",
			params: { recognizedEpisode: recognized.episode, assignedEpisode: row.episodeNumber },
		});
	}

	if (recognized.season !== null && row.seasonNumber !== null && recognized.season !== row.seasonNumber) {
		reasons.push({
			code: "season_mismatch",
			severity: "high",
			params: { recognizedSeason: recognized.season, assignedSeason: row.seasonNumber },
		});
	}

	return reasons;
}

/** Whether the media file still looks mismatched; a file that is gone is not suspect. */
export async function isAuditSuspect(mediaFileId: string): Promise<boolean> {
	const row = await mediaRepository.findAuditRow(mediaFileId);

	return row ? auditMediaFileRow(row) !== null : false;
}

export function auditMediaFileRow(row: MediaFileAuditRow): MediaFileAuditItem | null {
	const recognized = recognizeMediaFile(row);
	const reasons: MediaFileAuditReason[] = [];

	if (isSequelMismatch(recognized.title, { title: row.metadataTitle, originalTitle: row.metadataOriginalTitle })) {
		reasons.push({
			code: "sequel_mismatch",
			severity: "high",
			params: { recognizedTitle: recognized.title, assignedTitle: row.metadataTitle },
		});
	}

	if (recognized.year && row.metadataReleaseDate) {
		const yearReason = yearMismatchReason(recognized.year, row.metadataReleaseDate);
		if (yearReason) reasons.push(yearReason);
	}

	const simTitle = rankCandidates(
		[{ title: row.metadataTitle, originalTitle: row.metadataOriginalTitle ?? undefined }],
		recognized.title,
		recognized.year ?? undefined,
	)[0];
	const simScore = simTitle ? Number(simTitle.score.toFixed(3)) : 0;

	if (simScore < systemSettingsStore.get("metadata.minMatchScore") && !reasons.some((r) => r.code === "sequel_mismatch")) {
		reasons.push({
			code: "title_mismatch",
			severity: "high",
			params: { recognizedTitle: recognized.title, assignedTitle: row.metadataTitle },
		});
	}

	if (row.libraryType === "tv_shows") reasons.push(...tvNumberReasons(row, recognized));

	if (row.metadataMatchScore !== null && row.metadataMatchScore < REVIEW_MATCH_SCORE && reasons.length === 0) {
		reasons.push({
			code: "low_confidence",
			severity: "low",
			params: { percent: Math.round(row.metadataMatchScore * 100) },
		});
	}

	if (reasons.length === 0) return null;

	return {
		mediaFileId: row.mediaFileId,
		fileName: row.fileName,
		filePath: row.filePath,
		libraryId: row.libraryId,
		...(row.libraryName ? { libraryName: row.libraryName } : {}),
		mediaType: mapLibraryType(row.libraryType),
		currentMetadata: {
			id: row.metadataId,
			title: row.metadataTitle,
			originalTitle: row.metadataOriginalTitle,
			releaseDate: row.metadataReleaseDate,
			matchScore: row.metadataMatchScore,
			seasonNumber: row.seasonNumber,
			episodeNumber: row.episodeNumber,
		},
		recognized,
		reasons,
		similarityScore: simScore,
	};
}

export function sortAuditSuspects(suspects: MediaFileAuditItem[]): MediaFileAuditItem[] {
	// Precompute max severity once per suspect — computing it inside the
	// comparator would run it O(n log n) times per element.
	const maxSeverity = new Map<MediaFileAuditItem, number>(
		suspects.map((s) => [s, Math.max(...s.reasons.map((r) => SEVERITY_WEIGHTS[r.severity] ?? 0))]),
	);

	return suspects.toSorted((a, b) => {
		const maxSevA = maxSeverity.get(a) ?? 0;
		const maxSevB = maxSeverity.get(b) ?? 0;
		if (maxSevA !== maxSevB) return maxSevB - maxSevA;

		return a.similarityScore - b.similarityScore;
	});
}

import type { MediaFileAuditItem, MediaFileAuditReason, MediaFileAuditResponse } from "@sdk/common/media-file.types";
import { type MediaFileAuditRow, mediaRepository } from "@/database/repositories/media-files.repository";
import { recognitionService } from "@/modules/recognition/recognition.service";
import { parseFileName } from "@/modules/recognition/utils/recognition.utils";
import { isSequelMismatch, rankCandidates } from "@/utils/media-match.utils";
import { mapLibraryType } from "@/utils/type.utils";

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

export function auditMediaFileRow(row: MediaFileAuditRow): MediaFileAuditItem | null {
	const recognizedResult = recognitionService.recognize(row.filePath);
	const fallbackParsed = parseFileName(row.fileName);
	const recognized = {
		title: recognizedResult?.identity.title ?? fallbackParsed?.title ?? row.fileName,
		year: recognizedResult?.identity.year ?? fallbackParsed?.year ?? null,
		season: recognizedResult?.identity.season ?? fallbackParsed?.season ?? null,
		episode: recognizedResult?.identity.episode ?? fallbackParsed?.episode ?? null,
	};

	const reasons: MediaFileAuditReason[] = [];

	if (isSequelMismatch(recognized.title, { title: row.metadataTitle, originalTitle: row.metadataOriginalTitle })) {
		reasons.push({
			code: "sequel_mismatch",
			severity: "high",
			params: { recognizedTitle: recognized.title, assignedTitle: row.metadataTitle },
		});
	}

	if (recognized.year && row.metadataReleaseDate) {
		const assignedYear = Number.parseInt(row.metadataReleaseDate.slice(0, 4), 10);
		if (Number.isInteger(assignedYear)) {
			const yearDiff = Math.abs(recognized.year - assignedYear);
			if (yearDiff >= 3) {
				reasons.push({
					code: "year_mismatch",
					severity: "high",
					params: { recognizedYear: recognized.year, assignedYear, diff: yearDiff },
				});
			} else if (yearDiff === 2) {
				reasons.push({
					code: "year_mismatch",
					severity: "medium",
					params: { recognizedYear: recognized.year, assignedYear, diff: yearDiff },
				});
			}
		}
	}

	const simTitle = rankCandidates(
		[{ title: row.metadataTitle, originalTitle: row.metadataOriginalTitle ?? undefined }],
		recognized.title,
		recognized.year ?? undefined,
	)[0];
	const simScore = simTitle ? Number(simTitle.score.toFixed(3)) : 0;

	if (simScore < 0.45 && !reasons.some((r) => r.code === "sequel_mismatch")) {
		reasons.push({
			code: "title_mismatch",
			severity: "high",
			params: { recognizedTitle: recognized.title, assignedTitle: row.metadataTitle },
		});
	}

	if (row.libraryType === "tv_shows") {
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
	}

	if (row.metadataMatchScore !== null && row.metadataMatchScore < 0.65 && reasons.length === 0) {
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

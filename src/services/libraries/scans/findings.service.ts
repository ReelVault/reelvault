import type {
	ScanFindingCandidatesResponse,
	ScanFindingIgnoredResponse,
	ScanFindingStatus,
	ScanFindingsResponse,
} from "@reelvault/sdk/common";
import { parseFileName } from "@/modules/recognition/utils/recognition.utils";
import { providerService } from "@/plugins/capabilities/provider.service";
import { scanFindingsRepository } from "@/repositories/scan-findings.repository";
import { recordUpdateAudit } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { getLibraryForScan } from "@/services/libraries/crud.service";
import { librariesLog } from "@/services/libraries/libraries.logger";
import { assertExists, assertFound } from "@/utils/domain.errors";
import { mapLibraryType } from "@/utils/media-metadata.utils";
import { runSafely } from "@/utils/safe-execute.utils";

export async function getScanFindings(libraryId: string, status: ScanFindingStatus = "active"): Promise<ScanFindingsResponse> {
	return await runSafely(librariesLog, "getScanFindings", () => {
		const { items, counts, libraryExists } = scanFindingsRepository.listWithCounts(libraryId, status);
		assertExists(libraryExists, "Library", libraryId);

		return { data: items, counts };
	});
}

export async function setScanFindingIgnored(
	libraryId: string,
	filePath: string,
	ignored: boolean,
	context?: AdminAuditContext,
): Promise<ScanFindingIgnoredResponse> {
	return await runSafely(librariesLog, "setScanFindingIgnored", async () => {
		await getLibraryForScan(libraryId, { fields: "id" });

		const updated = await scanFindingsRepository.setIgnored(libraryId, filePath, ignored);
		assertExists(updated, "Scan finding", filePath);

		recordUpdateAudit(librariesLog.logger, {
			resourceType: "library",
			resourceId: libraryId,
			after: { scanFinding: filePath, ignored },
			context,
		});

		return { filePath, ignored };
	});
}

/** Searches the providers for the title parsed from a finding's file name. Runs on request only; only `no_metadata_match` findings are searched. */
export async function getScanFindingCandidates(libraryId: string, filePath: string): Promise<ScanFindingCandidatesResponse> {
	return await runSafely(librariesLog, "getScanFindingCandidates", async () => {
		const library = await getLibraryForScan(libraryId, { fields: "id,type" });
		const finding = await scanFindingsRepository.findByPath(libraryId, filePath);
		assertFound(finding, "Scan finding", filePath);

		const identity = parseFileName(finding.fileName);
		const searchTitle = identity?.title ?? null;
		const searchYear = identity?.year ?? null;
		if (finding.reason !== "no_metadata_match" || searchTitle === null) {
			return { searchTitle, searchYear, candidates: [] };
		}

		const candidates = await providerService.search({
			type: mapLibraryType(library.type),
			title: searchTitle,
			...(searchYear === null ? {} : { year: searchYear }),
		});

		return { searchTitle, searchYear, candidates };
	});
}

import type {
	ScanFindingCandidatesResponse,
	ScanFindingIgnoredResponse,
	ScanFindingStatus,
	ScanFindingsResponse,
} from "@reelvault/sdk/common";
import { recordUpdateAudit } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { scanFindingsRepository } from "@/app/repositories/scan-findings.repository";
import { parseFileName } from "@/modules/recognition/utils/recognition.utils";
import { providerService } from "@/plugins/capabilities/provider.service";
import { assertExists, assertFound } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { mapLibraryType } from "@/utils/type.utils";
import { getLibraryForScan } from "../crud.service";
import type { LibrariesServiceState } from "../shared.utils";

export async function getScanFindings(
	state: LibrariesServiceState,
	libraryId: string,
	status: ScanFindingStatus = "active",
): Promise<ScanFindingsResponse> {
	return await runSafely(state, "getScanFindings", () => {
		const { items, counts, libraryExists } = scanFindingsRepository.listWithCounts(libraryId, status);
		assertExists(libraryExists, "Library", libraryId);

		return { data: items, counts };
	});
}

export async function setScanFindingIgnored(
	state: LibrariesServiceState,
	libraryId: string,
	filePath: string,
	ignored: boolean,
	context?: AdminAuditContext,
): Promise<ScanFindingIgnoredResponse> {
	return await runSafely(state, "setScanFindingIgnored", async () => {
		await getLibraryForScan(libraryId, { fields: "id" });

		const updated = await scanFindingsRepository.setIgnored(libraryId, filePath, ignored);
		assertExists(updated, "Scan finding", filePath);

		recordUpdateAudit(state.logger, {
			resourceType: "library",
			resourceId: libraryId,
			after: { scanFinding: filePath, ignored },
			context,
		});

		return { filePath, ignored };
	});
}

/** Searches the providers for the title parsed from a finding's file name. Runs on request only; only `no_metadata_match` findings are searched. */
export async function getScanFindingCandidates(
	state: LibrariesServiceState,
	libraryId: string,
	filePath: string,
): Promise<ScanFindingCandidatesResponse> {
	return await runSafely(state, "getScanFindingCandidates", async () => {
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

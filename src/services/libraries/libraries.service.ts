import type {
	CreateLibrary,
	FieldsQuery,
	LibraryFilters,
	LibrarySorting,
	PaginationQuery,
	ScanFindingStatus,
	UpdateLibrary,
} from "@reelvault/sdk/common";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { createLogger } from "@/utils/logger.utils";
import { createLibrary, deleteLibrary, getAllLibraries, getLibraryById, updateLibrary } from "./crud.service";
import { checkLibraryErrors, getLibraryErrorsCheckStatus, getLibraryHealth } from "./health.service";
import { getScanFindingCandidates, getScanFindings, setScanFindingIgnored } from "./scans/findings.service";
import { cancelLibraryScans, getScanProgress, scanAllLibraries, scanLibrary, scanLibraryPath } from "./scans/scans.service";
import { libraryWatcherService } from "./watching/library-watcher.service";

class LibrariesService {
	readonly serviceName = "LibrariesService";
	readonly logger = createLogger("LibrariesService");

	constructor() {
		// Break the libraries ↔ watcher import cycle: the watcher calls back here.
		libraryWatcherService.registerScanner((libraryId, pathId) => this.scanPath(libraryId, pathId));
		libraryWatcherService.registerLibraryScanner((libraryId) => this.scan(libraryId));
	}

	getAll<F extends string>(query?: PaginationQuery & FieldsQuery<F> & LibrarySorting & LibraryFilters) {
		return getAllLibraries(this, query);
	}

	getById<F extends string>(libraryId: string, query?: FieldsQuery<F>, options?: { siblings?: boolean }) {
		return getLibraryById(this, libraryId, query, options);
	}

	create<F extends string>(body: CreateLibrary, query?: FieldsQuery<F>, context?: AdminAuditContext) {
		return createLibrary(this, body, query, context);
	}

	update<F extends string>(libraryId: string, body: UpdateLibrary, query?: FieldsQuery<F>, context?: AdminAuditContext) {
		return updateLibrary(this, libraryId, body, query, context);
	}

	delete(libraryId: string, context?: AdminAuditContext) {
		return deleteLibrary(this, libraryId, context);
	}

	scan(libraryId: string, context?: AdminAuditContext) {
		return scanLibrary(this, libraryId, context);
	}

	scanAll(context?: AdminAuditContext) {
		return scanAllLibraries(this, context);
	}

	cancelScans(libraryId: string, context?: AdminAuditContext) {
		return cancelLibraryScans(this, libraryId, context);
	}

	scanPath(libraryId: string, pathId: string, context?: AdminAuditContext) {
		return scanLibraryPath(this, libraryId, pathId, context);
	}

	getScanFindings(libraryId: string, status: ScanFindingStatus = "active") {
		return getScanFindings(this, libraryId, status);
	}

	setScanFindingIgnored(libraryId: string, filePath: string, ignored: boolean, context?: AdminAuditContext) {
		return setScanFindingIgnored(this, libraryId, filePath, ignored, context);
	}

	getScanFindingCandidates(libraryId: string, filePath: string) {
		return getScanFindingCandidates(this, libraryId, filePath);
	}

	getScanProgress() {
		return getScanProgress(this);
	}

	checkErrors(libraryPaths: string[], context?: AdminAuditContext) {
		return checkLibraryErrors(this, libraryPaths, context);
	}

	getErrorsCheckStatus(operationId: string) {
		return getLibraryErrorsCheckStatus(this, operationId);
	}

	getHealth() {
		return getLibraryHealth(this);
	}
}

export const librariesService = new LibrariesService();

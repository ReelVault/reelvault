import { createLibrary, deleteLibrary, getAllLibraries, getLibraryById, updateLibrary } from "./crud.service";
import { checkLibraryErrors, getLibraryErrorsCheckStatus, getLibraryHealth } from "./health.service";
import { getScanFindingCandidates, getScanFindings, setScanFindingIgnored } from "./scans/findings.service";
import { cancelLibraryScans, getScanProgress, scanAllLibraries, scanLibrary, scanLibraryPath } from "./scans/scans.service";

/** The library use cases: the library records, their scans and scan findings, and the health checks of their paths. */
export const librariesService = {
	getAll: getAllLibraries,
	getById: getLibraryById,
	create: createLibrary,
	update: updateLibrary,
	delete: deleteLibrary,
	scan: scanLibrary,
	scanAll: scanAllLibraries,
	cancelScans: cancelLibraryScans,
	scanPath: scanLibraryPath,
	getScanFindings,
	setScanFindingIgnored,
	getScanFindingCandidates,
	getScanProgress,
	checkErrors: checkLibraryErrors,
	getErrorsCheckStatus: getLibraryErrorsCheckStatus,
	getHealth: getLibraryHealth,
};

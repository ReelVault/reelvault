import { getAuditStatus, queueAudit } from "./audit.service";
import { reassign } from "./maintenance/reassign.service";
import { refresh, refreshAll, refreshMany, update } from "./maintenance/refresh.service";
import { deleteMany, deleteOne } from "./maintenance/remove.service";
import { deleteMarkers, exportMarkers, importMarkers, setMarkers } from "./markers.service";
import { getAll, getArtifact, getById, getPlaybackContext, listAllMarkers, listArtifacts, listMarkers } from "./queries.reader";
import { scan } from "./scan.service";

/**
 * The media file use cases, grouped by concern in this folder: reads, markers,
 * maintenance (refresh, reassign, remove), the audit and the health scan.
 */
export const mediaService = {
	getAll,
	getById,
	getPlaybackContext,
	listArtifacts,
	getArtifact,
	listMarkers,
	listAllMarkers,
	exportMarkers,
	importMarkers,
	setMarkers,
	deleteMarkers,
	update,
	refresh,
	refreshMany,
	refreshAll,
	scan,
	reassign,
	queueAudit,
	getAuditStatus,
	deleteMany,
	delete: deleteOne,
};

import { mediaRepository } from "@/repositories/media-files.repository";
import { sessionLifecycleService } from "./sessions/session-lifecycle.service";
import type { RequireSession } from "./streaming.types";

/** Shared session-access dependency defaults for the streaming services. */
export const defaultRequireSession: RequireSession = (sessionId, label) => sessionLifecycleService.requireSession(sessionId, label);

export function defaultFindForStreamingDuration(mediaFileId: string) {
	return mediaRepository.findForStreamingDuration(mediaFileId);
}

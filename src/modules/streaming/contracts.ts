import { mediaRepository } from "@/database/repositories/media-files.repository";
import { sessionLifecycleService } from "./sessions/session-lifecycle.service";
import type { RequireSession } from "./streaming.types";

/** Shared session-access dependency defaults for the streaming services. */
export const defaultRequireSession: RequireSession = (sessionId, label) => sessionLifecycleService.requireSession(sessionId, label);

export const defaultFindForStreamingDuration = (mediaFileId: string) => mediaRepository.findForStreamingDuration(mediaFileId);

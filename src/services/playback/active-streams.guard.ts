import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { DomainError } from "@/utils/domain.errors";

/**
 * Refuses a deletion while a stream is playing any of the given media files,
 * unless the caller explicitly forces it. Accepts a set for bulk deletes and a
 * single id for the one-row path; the active-stream count is reported in the
 * error params either way.
 */
export function assertNoActiveStreamsForMediaFileIds(
	mediaFileIds: ReadonlySet<string> | string,
	options: { force?: boolean | undefined; message: string; code: string },
): void {
	if (options.force === true) return;

	const activeMediaFileIds = streamingManager.getActiveMediaFileIds();
	let activeStreams = 0;
	if (typeof mediaFileIds === "string") {
		if (activeMediaFileIds.has(mediaFileIds)) activeStreams = 1;
	} else {
		for (const mediaFileId of mediaFileIds) {
			if (activeMediaFileIds.has(mediaFileId)) activeStreams++;
		}
	}

	if (activeStreams > 0) {
		throw new DomainError("conflict", options.message, { code: options.code, params: { activeStreams } });
	}
}

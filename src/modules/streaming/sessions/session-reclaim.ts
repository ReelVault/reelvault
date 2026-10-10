/**
 * The profile's session of the same title as `mediaFileId`: the one a new start may take over when the server is at its
 * session limit. `titleOf` maps a media file id to its title (metadata) id.
 */
export function findSameTitleSession<T extends { sessionId: string; mediaFileId: string }>(
	profileSessions: readonly T[],
	titleOf: ReadonlyMap<string, string>,
	mediaFileId: string,
): T | undefined {
	const title = titleOf.get(mediaFileId);
	if (!title) return undefined;

	return profileSessions.find((session) => titleOf.get(session.mediaFileId) === title);
}

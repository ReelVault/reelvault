export function canReserveStreamingSession({
	activeSessions,
	reservedSessions,
	maxSessions,
	activeUserSessions,
	reservedUserSessions,
	maxSessionsPerUser,
	alreadyAllocated,
}: {
	activeSessions: number;
	reservedSessions: number;
	maxSessions: number;
	activeUserSessions?: number | undefined;
	reservedUserSessions?: number | undefined;
	maxSessionsPerUser?: number | undefined;
	alreadyAllocated: boolean;
}): boolean {
	if (alreadyAllocated) return true;

	if (activeSessions + reservedSessions >= maxSessions) return false;

	if (
		maxSessionsPerUser !== undefined &&
		activeUserSessions !== undefined &&
		reservedUserSessions !== undefined &&
		activeUserSessions + reservedUserSessions >= maxSessionsPerUser
	) {
		return false;
	}

	return true;
}

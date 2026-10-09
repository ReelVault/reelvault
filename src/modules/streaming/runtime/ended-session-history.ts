/** The most ended sessions the history keeps; the oldest are dropped first. */
export const ENDED_SESSION_HISTORY_LIMIT = 200;

export interface EndedLiveSession {
	sessionId: string;
	mediaFileId: string;
	profileId: string;
	reason: string;
	startedAt: number;
	endedAt: number;
}

/** In memory and bounded: a long-running server keeps only the latest endings for the admin view. */
export class EndedSessionHistory {
	private readonly sessions: EndedLiveSession[] = [];

	record(session: EndedLiveSession): void {
		this.sessions.push(session);

		const excess = this.sessions.length - ENDED_SESSION_HISTORY_LIMIT;
		if (excess > 0) this.sessions.splice(0, excess);
	}

	/** The newest `limit` endings, newest first. */
	list(limit: number): EndedLiveSession[] {
		if (limit <= 0) return [];

		return this.sessions.slice(-limit).toReversed();
	}
}

export const endedSessionHistory = new EndedSessionHistory();

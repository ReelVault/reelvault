/**
 * Token-refresh mutex.
 *
 * When concurrent requests get a 401, only the first calls `onTokenExpired`;
 * the rest await the same shared promise. This prevents a refresh stampede and
 * repeated hits on the auth endpoint.
 */
export class TokenManager {
	private refreshPromise: Promise<string | undefined> | null = null;

	refresh(refresher: () => Promise<string> | string): Promise<string | undefined> {
		if (this.refreshPromise !== null) return this.refreshPromise;

		const promise = (async () => {
			try {
				const token = await refresher();

				return typeof token === "string" && token.length > 0 ? token : undefined;
			} finally {
				this.refreshPromise = null;
			}
		})();
		this.refreshPromise = promise;

		return promise;
	}
}

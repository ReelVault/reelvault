export interface CollectKeysetPagesOptions<TRow> {
	/** Rows fetched per page; also the threshold below which iteration stops. */
	pageSize: number;
	/** Fetches one page; `cursor` is the previous page's last id (`undefined` on the first call). */
	fetchPage: (cursor: string | undefined) => Promise<TRow[]>;
	/** Next-page cursor; defaults to the last row's non-empty `id`. */
	cursorOf?: ((rows: TRow[]) => string | undefined) | undefined;
	/** Runs for every non-empty page before the next fetch. */
	onPage: (rows: TRow[]) => Promise<void> | void;
	/** Runs before every fetch, including the first (cancellation checks). */
	beforePage?: (() => Promise<void> | void) | undefined;
	/** Runs only when a full page was processed and another fetch follows (event-loop yielding). */
	betweenPages?: (() => Promise<void> | void) | undefined;
}

function defaultCursorOf(rows: unknown[]): string | undefined {
	const last = rows.at(-1);
	if (typeof last === "string") return last.length > 0 ? last : undefined;

	if (typeof last !== "object" || last === null || !("id" in last)) return undefined;

	return typeof last.id === "string" && last.id.length > 0 ? last.id : undefined;
}

/**
 * Drives a keyset-paginated (ascending primary key) query page by page.
 *
 * Iteration stops on the first empty page, on a page shorter than `pageSize`,
 * or when a page carries no usable cursor — identical to the hand-rolled
 * `for (;;)` cursor loops this replaces. Returns the total number of rows seen.
 * Callers accumulate results or run per-page side effects (deletes, enqueues,
 * per-page transactions) in `onPage`.
 */
export async function collectKeysetPages<TRow>({
	pageSize,
	fetchPage,
	cursorOf,
	onPage,
	beforePage,
	betweenPages,
}: CollectKeysetPagesOptions<TRow>): Promise<number> {
	let cursor: string | undefined;
	let total = 0;
	for (;;) {
		await beforePage?.();
		const rows = await fetchPage(cursor);
		if (rows.length === 0) break;

		await onPage(rows);
		total += rows.length;
		if (rows.length < pageSize) break;

		const lastId = cursorOf ? cursorOf(rows) : defaultCursorOf(rows);
		if (!lastId) break;

		cursor = lastId;
		await betweenPages?.();
	}

	return total;
}

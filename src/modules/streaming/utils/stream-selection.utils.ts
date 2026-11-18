/** The flagged default stream, or the lowest-index one when none is flagged. */
export function selectDefaultOrFirstStream<T extends { index: number; isDefault: boolean }>(streams: readonly T[]): T | undefined {
	let firstByIndex: T | undefined;
	for (const stream of streams) {
		if (stream.isDefault) return stream;

		if (!firstByIndex || stream.index < firstByIndex.index) firstByIndex = stream;
	}

	return firstByIndex;
}

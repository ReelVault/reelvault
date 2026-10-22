import { sleep } from "bun";

/**
 * Polls `predicate` every 2 ms until it holds. A predicate that never holds fails after `attempts`
 * polls, so a test waiting on an event that never happens fails instead of hanging.
 */
export async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 500): Promise<void> {
	for (let attempt = 0; !(await predicate()); attempt++) {
		if (attempt >= attempts) throw new Error("The awaited condition never held");

		await sleep(2);
	}
}

import { afterEach, beforeEach } from "bun:test";

/**
 * Runs every test of the calling file in `timeZone` and puts the process time
 * zone back afterwards, so a date bug that only shows away from UTC fails on
 * every machine, whatever zone the runner is set to.
 */
export function useTimeZone(timeZone: string): void {
	let original: string | undefined;

	beforeEach(() => {
		original = process.env.TZ;
		process.env.TZ = timeZone;
	});

	afterEach(() => {
		if (original === undefined) Reflect.deleteProperty(process.env, "TZ");
		else process.env.TZ = original;
	});
}

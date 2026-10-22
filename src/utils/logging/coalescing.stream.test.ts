import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { CoalescingStream } from "./coalescing.stream";

/** A target that records what reaches it. `flush` mirrors Bun's `process.stdout`, which carries a boolean there. */
function recordingTarget(flush: boolean | (() => Promise<void>)): { target: Writable & { flush: typeof flush }; written: string[] } {
	const written: string[] = [];
	const target = Object.assign(
		new Writable({
			write(chunk: Buffer, _encoding, callback) {
				written.push(chunk.toString());
				callback();
			},
		}),
		{ flush },
	);

	return { target, written };
}

test("drains to a stdout-like target whose flush is a boolean, so shutdown can flush the logs and exit", async () => {
	const { target, written } = recordingTarget(false);
	const stream = new CoalescingStream(target);

	stream.write("first line\n");
	stream.write("second line\n");
	await stream.drain();

	expect(written.join("")).toBe("first line\nsecond line\n");
});

test("drains and then flushes a file target that offers flush", async () => {
	const flushed: string[] = [];
	const { target, written } = recordingTarget(() => {
		flushed.push(written.join(""));

		return Promise.resolve();
	});
	const stream = new CoalescingStream(target);

	stream.write("line\n");
	await stream.drain();

	expect(flushed).toEqual(["line\n"]);
});

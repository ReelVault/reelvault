import { describe, expect, test } from "bun:test";
import { fingerprintPlaybackSession, PlaybackSessionIdempotencyRegistry } from "./playback-session.registry";

describe("PlaybackSessionIdempotencyRegistry", () => {
	test("normalizes codec order before fingerprinting", () => {
		// The fingerprint is "<media file id>|<video codecs>|<audio codecs>|<max bitrate>|<audio stream
		// index>|<audio language>|<subtitle language>|<subtitles enabled>|<forced subtitles only>",
		// with the ids lowercased and the codec lists trimmed, deduped and sorted.
		expect(fingerprintPlaybackSession({ mediaFileId: "Media-1", videoCodecs: ["AV1", " h264", "av1"], audioCodecs: ["AAC"] })).toBe(
			"media-1|av1,h264|aac||||||",
		);
	});

	test("gives a different fingerprint to a different media file", () => {
		expect(fingerprintPlaybackSession({ mediaFileId: "media-2", videoCodecs: ["AV1", " h264", "av1"], audioCodecs: ["AAC"] })).toBe(
			"media-2|av1,h264|aac||||||",
		);
	});

	test("shares the one in-flight creation for a profile and key", async () => {
		const registry = new PlaybackSessionIdempotencyRegistry();
		let starts = 0;
		let finish!: (value: string) => void;
		const create = () => {
			starts++;

			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		};
		const body = { mediaFileId: "file-1", videoCodecs: ["h264"] };

		const first = registry.execute("profile-1", "key-1", body, create);
		const second = registry.execute("profile-1", "key-1", body, create);
		expect(starts).toBe(1);
		finish("session-1");
		await expect(first).resolves.toBe("session-1");
		await expect(second).resolves.toBe("session-1");
	});

	test("rejects reusing a key with different semantic input", async () => {
		const registry = new PlaybackSessionIdempotencyRegistry();
		const first = registry.execute("profile-1", "key-1", { mediaFileId: "file-1" }, async () => "session-1");
		expect(() => registry.execute("profile-1", "key-1", { mediaFileId: "file-2" }, async () => "session-2")).toThrow(
			expect.objectContaining({
				category: "conflict",
				code: "stream.idempotency_conflict",
			}),
		);
		await expect(first).resolves.toBe("session-1");
	});
});

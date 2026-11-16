import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeSync } from "@/utils/directory.utils";
import { cleanupStartupDirectories, measureDirectory } from "./server-data.utils";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "reelvault-server-data-"));
	temporaryDirectories.push(directory);

	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) removeTreeSync(directory);
});

test("cleanupStartupDirectories removes contents of target directories", async () => {
	const base = makeTemporaryDirectory();
	const testTranscodes = join(base, "transcodes");
	const testTmp = join(base, ".tmp");

	mkdirSync(join(testTranscodes, "session-123"), { recursive: true });
	writeFileSync(join(testTranscodes, "session-123", "segment001.ts"), "dummy content");
	writeFileSync(join(testTranscodes, "master.m3u8"), "dummy playlist");

	mkdirSync(testTmp, { recursive: true });
	writeFileSync(join(testTmp, "temp-image.bin"), "temp image");

	expect(existsSync(join(testTranscodes, "master.m3u8"))).toBe(true);
	expect(existsSync(join(testTmp, "temp-image.bin"))).toBe(true);

	await cleanupStartupDirectories({ targets: [testTranscodes, testTmp] });

	expect(existsSync(testTranscodes)).toBe(true);
	expect(existsSync(testTmp)).toBe(true);
	expect(readdirSync(testTranscodes).length).toBe(0);
	expect(readdirSync(testTmp).length).toBe(0);
});

test("periodic cleanup keeps scratch files while removing old sessions", async () => {
	const base = makeTemporaryDirectory();
	const testTranscodes = join(base, "transcodes");
	const trickplayScratch = join(testTranscodes, ".tmp", "trickplay_media-1_uuid");
	mkdirSync(trickplayScratch, { recursive: true });
	writeFileSync(join(trickplayScratch, "sprite_0.webp"), "sprite bytes");
	mkdirSync(join(testTranscodes, "session-123"), { recursive: true });
	writeFileSync(join(testTranscodes, "session-123", "segment001.ts"), "stale segment");

	await cleanupStartupDirectories({ targets: [testTranscodes] });

	expect(existsSync(join(trickplayScratch, "sprite_0.webp"))).toBe(true);
	expect(existsSync(join(testTranscodes, "session-123"))).toBe(false);
});

test("boot cleanup removes scratch files left by a crashed worker", async () => {
	const base = makeTemporaryDirectory();
	const testTranscodes = join(base, "transcodes");
	const trickplayScratch = join(testTranscodes, ".tmp", "trickplay_media-1_uuid");
	mkdirSync(trickplayScratch, { recursive: true });
	writeFileSync(join(trickplayScratch, "sprite_0.webp"), "sprite bytes");

	await cleanupStartupDirectories({ targets: [testTranscodes], includeTempDirectories: true });

	expect(existsSync(join(trickplayScratch, "sprite_0.webp"))).toBe(false);
});

test("measureDirectory sums file sizes recursively", async () => {
	const base = makeTemporaryDirectory();
	mkdirSync(join(base, "nested"), { recursive: true });
	writeFileSync(join(base, "a.bin"), "12345"); // 5 bytes
	writeFileSync(join(base, "nested", "b.bin"), "1234567890"); // 10 bytes
	// empty subdirectory — no files, must not break the walk
	mkdirSync(join(base, "empty"), { recursive: true });

	const result = await measureDirectory(base);

	expect(result.files).toBe(2);
	expect(result.bytes).toBe(15);
});

test("measureDirectory returns zeros for a missing directory", async () => {
	const result = await measureDirectory(join(makeTemporaryDirectory(), "missing"));

	expect(result).toEqual({ bytes: 0, files: 0 });
});

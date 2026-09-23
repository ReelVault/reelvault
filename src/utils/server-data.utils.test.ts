import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupStartupDirectories, measureDirectory } from "./server-data.utils";

test("cleanupStartupDirectories removes contents of target directories", async () => {
	const testBase = "/tmp/reelvault-cleanup-test";
	const testTranscodes = join(testBase, "transcodes");
	const testTmp = join(testBase, ".tmp");

	mkdirSync(join(testTranscodes, "session-123"), { recursive: true });
	writeFileSync(join(testTranscodes, "session-123", "segment001.ts"), "dummy content");
	writeFileSync(join(testTranscodes, "master.m3u8"), "dummy playlist");

	mkdirSync(testTmp, { recursive: true });
	writeFileSync(join(testTmp, "temp-image.bin"), "temp image");

	expect(existsSync(join(testTranscodes, "master.m3u8"))).toBe(true);
	expect(existsSync(join(testTmp, "temp-image.bin"))).toBe(true);

	await cleanupStartupDirectories([testTranscodes, testTmp]);

	expect(existsSync(testTranscodes)).toBe(true);
	expect(existsSync(testTmp)).toBe(true);
	expect(readdirSync(testTranscodes).length).toBe(0);
	expect(readdirSync(testTmp).length).toBe(0);
});

test("measureDirectory sums file sizes recursively", async () => {
	const testBase = "/tmp/reelvault-measure-test";
	mkdirSync(join(testBase, "nested"), { recursive: true });
	writeFileSync(join(testBase, "a.bin"), "12345"); // 5 bytes
	writeFileSync(join(testBase, "nested", "b.bin"), "1234567890"); // 10 bytes
	// empty subdirectory — no files, must not break the walk
	mkdirSync(join(testBase, "empty"), { recursive: true });

	const result = await measureDirectory(testBase);

	expect(result.files).toBe(2);
	expect(result.bytes).toBe(15);
});

test("measureDirectory returns zeros for a missing directory", async () => {
	const result = await measureDirectory("/tmp/reelvault-measure-does-not-exist");

	expect(result).toEqual({ bytes: 0, files: 0 });
});

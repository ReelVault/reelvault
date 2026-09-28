import { describe, expect, test } from "bun:test";
import { assertChecksumMatches, checksumForFile, serverAssetName, webAssetName } from "./update-release.utils";

describe("serverAssetName", () => {
	test("maps linux x64 and arm64 and windows", () => {
		expect(serverAssetName("linux", "x64", "1.2.3")).toBe("ReelVault-Server-1.2.3-linux-x64.tar.gz");
		expect(serverAssetName("linux", "arm64", "1.2.3")).toBe("ReelVault-Server-1.2.3-linux-arm64.tar.gz");
		expect(serverAssetName("win32", "x64", "1.2.3")).toBe("ReelVault-Server-1.2.3-windows-x64.zip");
	});

	test("has no flavor dimension — a full install keeps its bin/ across updates", () => {
		expect(serverAssetName("linux", "x64", "1.2.3")).not.toContain("full");
	});

	test("rejects unsupported platforms", () => {
		expect(() => serverAssetName("darwin", "x64", "1.2.3")).toThrow();
	});
});

describe("webAssetName", () => {
	test("is platform-independent", () => {
		expect(webAssetName("0.2.0")).toBe("reelvault-web-0.2.0.zip");
	});
});

describe("checksumForFile", () => {
	const sums = [
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  ReelVault-Server-1.2.3-linux-x64.tar.gz",
		"aabb  reelvault-web-0.2.0.zip", // too short — ignored by the regex
	].join("\n");

	test("finds the entry for the requested asset", () => {
		expect(checksumForFile(sums, "ReelVault-Server-1.2.3-linux-x64.tar.gz")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	test("returns undefined for unknown files and malformed lines", () => {
		expect(checksumForFile(sums, "reelvault-web-0.2.0.zip")).toBeUndefined();
		expect(checksumForFile(sums, "ReelVault-Server-9.9.9-linux-x64.tar.gz")).toBeUndefined();
	});

	test("handles the binary-mode marker (hash *file)", () => {
		const binarySums = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *ReelVault-Server-1.2.3-linux-x64.tar.gz";
		expect(checksumForFile(binarySums, "ReelVault-Server-1.2.3-linux-x64.tar.gz")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});

describe("assertChecksumMatches", () => {
	test("accepts equal digests regardless of case", () => {
		expect(() => assertChecksumMatches("AABB", "aabb")).not.toThrow();
	});

	test("rejects different digests and different lengths", () => {
		expect(() => assertChecksumMatches("aabb", "ccdd")).toThrow();
		expect(() => assertChecksumMatches("aabb", "aabbcc")).toThrow();
	});
});

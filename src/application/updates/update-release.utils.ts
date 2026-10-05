import { constantTimeEquals } from "@/utils/crypto.utils";
import { ValidationError } from "@/utils/errors";

const SHA256_LINE_REGEX = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;
const CURRENT_DIRECTORY_PREFIX_REGEX = /^\.\//;

/**
 * File name of the server release asset for the running platform. Server
 * archives ship a single flavor — a bundled-ffmpeg install keeps its existing
 * `bin/` across updates, so the flavor dimension does not exist here.
 */
export function serverAssetName(platform: NodeJS.Platform, arch: string, version: string): string {
	if (platform === "win32") return `ReelVault-Server-${version}-windows-x64.zip`;
	if (platform === "linux" && arch === "arm64") return `ReelVault-Server-${version}-linux-arm64.tar.gz`;
	if (platform === "linux") return `ReelVault-Server-${version}-linux-x64.tar.gz`;

	throw new ValidationError(`Self-update is not supported on ${platform}/${arch}`, { code: "update.platform_unsupported" });
}

/** File name of the web release asset (platform-independent). */
export function webAssetName(version: string): string {
	return `reelvault-web-${version}.zip`;
}

/** Extracts the hex digest for `fileName` from a `sha256sum`-style listing. */
export function checksumForFile(contents: string, fileName: string): string | undefined {
	for (const line of contents.split("\n")) {
		const match = SHA256_LINE_REGEX.exec(line.trim());
		const name = match?.[2]?.replace(CURRENT_DIRECTORY_PREFIX_REGEX, "");
		if (name === fileName) return match?.[1]?.toLowerCase();
	}

	return undefined;
}

/** Constant-time comparison of the streamed hash against the published digest. */
export function assertChecksumMatches(actualHex: string, expectedHex: string): void {
	if (!constantTimeEquals(actualHex, expectedHex, { checksum: true })) {
		throw new ValidationError("Downloaded release archive failed the SHA256 verification", { code: "update.checksum_mismatch" });
	}
}

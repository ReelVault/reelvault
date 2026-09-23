import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { assertChecksumMatches, downloadArchive, extractPluginPackage } from "./plugin-package.utils";

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup().catch(() => undefined)));
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("plugin package utils", () => {
	test("extracts a zipball with a repository wrapper directory and locates the plugin", async () => {
		const archivePath = await writeArchive(
			new Uint8Array(
				zipSync({
					"reelvault-plugins-main/org.example.zipped/plugin.json": strToU8(JSON.stringify({ id: "org.example.zipped" })),
					"reelvault-plugins-main/org.example.zipped/index.mjs": strToU8("export default { setup() {} };\n"),
				}),
			),
		);

		const extracted = await extractPluginPackage(archivePath);
		deferCleanup(extracted.cleanup);

		expect(extracted.pluginRoot.endsWith("org.example.zipped")).toBe(true);
	});

	test("extracts a gzipped tarball with ustar prefix paths", async () => {
		// A directory name over 100 characters forces the ustar prefix/name split.
		const pluginDirectory = `${"directory-with-a-very-long-name-".repeat(3)}x`;
		const tar = buildTar([
			{ path: `${pluginDirectory}/plugin.json`, data: strToU8(JSON.stringify({ id: "org.example.tarred" })) },
			{ path: `${pluginDirectory}/index.mjs`, data: strToU8("export default { setup() {} };\n") },
		]);
		const archivePath = await writeArchive(Uint8Array.from(Bun.gzipSync(tar)));

		const extracted = await extractPluginPackage(archivePath);
		deferCleanup(extracted.cleanup);

		expect(extracted.pluginRoot.endsWith("x")).toBe(true);
	});

	test("rejects zip entries escaping the extraction root", async () => {
		const archivePath = await writeArchive(Uint8Array.from(zipSync({ "../evil.txt": strToU8("nope") })));
		await expect(extractPluginPackage(archivePath)).rejects.toThrow("unsafe entry path");
	});

	test("rejects tar entries containing symbolic links", async () => {
		const tar = buildTar([{ path: "link.mjs", linkTo: "./target.mjs" }]);
		const archivePath = await writeArchive(Uint8Array.from(Bun.gzipSync(tar)));
		await expect(extractPluginPackage(archivePath)).rejects.toThrow("unsupported tar entry type");
	});

	test("rejects a package without a plugin.json manifest", async () => {
		const archivePath = await writeArchive(Uint8Array.from(zipSync({ "random/file.txt": strToU8("content") })));
		await expect(extractPluginPackage(archivePath)).rejects.toThrow("plugin.json");
	});

	test("rejects a zip whose actual inflated size exceeds the uncompressed cap", async () => {
		// Highly compressible entries: the compressed archive is tiny, the inflated
		// tree is not. The cap must be enforced on real output, not headers.
		const archivePath = await writeArchive(
			Uint8Array.from(
				zipSync({ "org.example.bomb/plugin.json": strToU8("{}"), "org.example.bomb/big.bin": strToU8("0".repeat(64 * 1024)) }),
			),
		);
		await expect(extractPluginPackage(archivePath, 1024)).rejects.toThrow("uncompressed size limit");
	});

	test("rejects a gzipped tarball whose actual inflated size exceeds the uncompressed cap", async () => {
		const tar = buildTar([
			{ path: "org.example.bomb/plugin.json", data: strToU8("{}") },
			{ path: "org.example.bomb/big.bin", data: strToU8("0".repeat(64 * 1024)) },
		]);
		const archivePath = await writeArchive(Uint8Array.from(Bun.gzipSync(tar)));
		await expect(extractPluginPackage(archivePath, 1024)).rejects.toThrow("uncompressed size limit");
	});

	test("compares checksums in constant time and rejects mismatches", () => {
		const checksumA = `sha256-${"a".repeat(64)}`;
		const checksumB = `sha256-${"b".repeat(64)}`;
		assertChecksumMatches(checksumA, checksumA);
		expect(() => assertChecksumMatches(checksumA, checksumB)).toThrow("checksum does not match");
	});

	test("downloads an archive over HTTP, hashing the exact bytes", async () => {
		const payload = zipSync({ "org.example.served/plugin.json": strToU8("{}") });
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(payload, { headers: { "content-type": "application/zip" } }),
		});
		try {
			const downloaded = await downloadArchive(`http://127.0.0.1:${server.port}/package.zip`, {
				fetcher: (url, init) => fetch(url, init),
			});
			deferCleanup(downloaded.cleanup);
			const expected = `sha256-${new Bun.CryptoHasher("sha256").update(payload).digest("hex")}`;
			expect(downloaded.checksum).toBe(expected);
			expect(downloaded.size).toBe(payload.byteLength);
		} finally {
			await server.stop(true);
		}
	});

	test("rejects a non-https download URL before any request is made", async () => {
		await expect(downloadArchive("http://127.0.0.1/package.zip")).rejects.toThrow("Only https downloads are allowed");
	});

	test("enforces the download size cap mid-stream", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(1024).fill(1));
							controller.enqueue(new Uint8Array(2048).fill(1));
							controller.close();
						},
					}),
				),
		});
		try {
			await expect(
				downloadArchive(`http://127.0.0.1:${server.port}/big.bin`, { maxBytes: 1024, fetcher: (url, init) => fetch(url, init) }),
			).rejects.toThrow("exceeds the");
		} finally {
			await server.stop(true);
		}
	});
});

async function writeArchive(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-plugin-pkg-test-"));
	temporaryDirectories.push(directory);
	const archivePath = join(directory, "package.bin");
	await Bun.write(archivePath, new Blob([bytes]));

	return archivePath;
}

function deferCleanup(cleanup: () => Promise<void>): void {
	cleanups.push(cleanup);
}

interface TarEntry {
	path: string;
	data?: Uint8Array;
	linkTo?: string;
}

/** Minimal ustar writer — enough to exercise the reader, including long names via the prefix field. */
function buildTar(entries: TarEntry[]): Uint8Array<ArrayBuffer> {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const { name, prefix } = splitTarPath(entry.path);
		const header = new Uint8Array(512);
		const encoder = new TextEncoder();
		header.set(encoder.encode(name).subarray(0, 100), 0);
		header.set(encoder.encode("0000644"), 100);
		header.set(encoder.encode("0000000"), 108);
		header.set(encoder.encode("0000000"), 116);
		const size = entry.data?.byteLength ?? (entry.linkTo ? entry.linkTo.length : 0);
		header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
		header.set(encoder.encode("00000000000"), 136);
		header.set(encoder.encode(entry.linkTo ? "2" : "0"), 156);
		header.set(encoder.encode("ustar\0"), 257);
		header.set(encoder.encode("00"), 263);
		header.set(encoder.encode(prefix), 345);
		header.set(encoder.encode("        "), 148);
		let checksum = 0;
		for (const byte of header) checksum += byte;

		header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);

		blocks.push(header);
		if (entry.data) blocks.push(padToBlock(entry.data));
	}

	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
	const tar = new Uint8Array(total);
	let offset = 0;
	for (const block of blocks) {
		tar.set(block, offset);
		offset += block.byteLength;
	}

	return tar;
}

function splitTarPath(path: string): { name: string; prefix: string } {
	if (path.length <= 100) return { name: path, prefix: "" };

	// Prefer the latest split that keeps the name within 100 bytes; fall back to
	// the first separator so the name never has to be truncated.
	const split = Math.max(path.lastIndexOf("/", path.length - 100), path.indexOf("/"));

	return { name: path.slice(split + 1), prefix: path.slice(0, split) };
}

function padToBlock(data: Uint8Array): Uint8Array {
	const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
	padded.set(data);

	return padded;
}

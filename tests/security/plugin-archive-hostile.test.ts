import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { extractPluginPackage } from "@/plugins/catalog/plugin-package/extract.extractor";
import { removeTree } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";

/**
 * Hostile plugin packages. Every archive below tries to escape the extraction root,
 * to plant a device, a hard link or an oversized member, or to hide a path inside a
 * PAX header. Extraction may accept or refuse each one, but it must never write a
 * byte outside its work directory, and a refusal must be a coded domain error (a raw
 * exception would surface as an anonymous 500).
 */

const created: string[] = [];

const LEADING_SLASH = /^\//;

afterEach(async () => {
	await Promise.all(created.splice(0).map(async (path) => await removeTree(path)));
});

async function writeArchive(bytes: Uint8Array): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "reelvault-hostile-"));
	created.push(directory);
	const archivePath = join(directory, "package.bin");
	await Bun.write(archivePath, bytes);

	return archivePath;
}

/** A sentinel name placed where a traversal would land: one level above the extraction root. */
function sentinel(): string {
	const name = `hostile-sentinel-${crypto.randomUUID()}.txt`;
	created.push(join(tmpdir(), name));

	return name;
}

interface HostileEntry {
	name: string;
	typeflag?: string;
	data?: Uint8Array;
	linkname?: string;
}

function octal(value: number, width: number): string {
	return value.toString(8).padStart(width - 1, "0");
}

function tarHeader(entry: HostileEntry, size: number): Uint8Array {
	const header = new Uint8Array(512);
	const encoder = new TextEncoder();
	header.set(encoder.encode(entry.name).subarray(0, 100), 0);
	header.set(encoder.encode("0000644\0"), 100);
	header.set(encoder.encode("0000000\0"), 108);
	header.set(encoder.encode("0000000\0"), 116);
	header.set(encoder.encode(`${octal(size, 12)}\0`), 124);
	header.set(encoder.encode("00000000000\0"), 136);
	header.set(encoder.encode("        "), 148);
	header.set(encoder.encode(entry.typeflag ?? "0"), 156);
	if (entry.linkname) header.set(encoder.encode(entry.linkname).subarray(0, 100), 157);
	header.set(encoder.encode("ustar\0"), 257);
	header.set(encoder.encode("00"), 263);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.set(encoder.encode(`${octal(checksum, 7)}\0 `), 148);

	return header;
}

function buildTar(entries: HostileEntry[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const data = entry.data ?? new Uint8Array(0);
		blocks.push(tarHeader(entry, data.byteLength));
		if (data.byteLength > 0) {
			const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
			padded.set(data);
			blocks.push(padded);
		}
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

/** A PAX extended header record: `<length> path=<value>\n`, where the length counts itself. */
function paxPathRecord(path: string): Uint8Array {
	const body = ` path=${path}\n`;
	for (let length = body.length; ; length += 1) {
		const record = `${length}${body}`;
		if (record.length === length) return strToU8(record);
	}
}

const PLUGIN_MANIFEST = strToU8(
	JSON.stringify({ id: "org.example.hostile", name: "Hostile", version: "1.0.0", entry: "./index.mjs", capabilities: ["eventHandler"] }),
);
const PLUGIN_ENTRY = strToU8("export default { setup() {} };\n");

async function expectContained(archive: Uint8Array, sentinelName: string): Promise<{ refused: boolean; code: string | undefined }> {
	const archivePath = await writeArchive(archive);
	let refused = false;
	let code: string | undefined;
	try {
		const extracted = await extractPluginPackage(archivePath);
		await extracted.cleanup();
	} catch (error) {
		refused = true;
		expect(error).toBeInstanceOf(DomainError);
		if (error instanceof DomainError) code = error.code;
	}
	expect(existsSync(join(tmpdir(), sentinelName))).toBe(false);

	return { refused, code };
}

test("tar entries that climb out of the root are refused as unsafe paths", async () => {
	const name = sentinel();
	const outcome = await expectContained(buildTar([{ name: `../${name}`, data: strToU8("escape") }]), name);

	expect(outcome).toEqual({ refused: true, code: "plugin.package_path_unsafe" });
});

test("tar entries with an absolute path are refused as unsafe paths and write nothing", async () => {
	const name = sentinel();
	const outcome = await expectContained(
		buildTar([{ name: `/${join(tmpdir(), name).replace(LEADING_SLASH, "")}`, data: strToU8("absolute") }]),
		name,
	);

	expect(outcome).toEqual({ refused: true, code: "plugin.package_path_unsafe" });
});

test("a PAX header that rewrites the path of the next member cannot escape the root", async () => {
	const name = sentinel();
	const archive = buildTar([
		{ name: "PaxHeader", typeflag: "x", data: paxPathRecord(`../${name}`) },
		{ name: "plugin.json", data: PLUGIN_MANIFEST },
		{ name: "index.mjs", data: PLUGIN_ENTRY },
	]);

	// The extractor refuses the PAX header itself: it supports neither the
	// extended header nor the path it would rewrite.
	expect(await expectContained(archive, name)).toEqual({ refused: true, code: "plugin.package_entry_unsupported" });
});

test("hard links are refused as unsupported entries, whatever they point at", async () => {
	const name = sentinel();
	const outcome = await expectContained(
		buildTar([
			{ name: "plugin.json", data: PLUGIN_MANIFEST },
			{ name: "link-to-host", typeflag: "1", linkname: `../${name}` },
			{ name: "link-to-passwd", typeflag: "1", linkname: "/etc/passwd" },
		]),
		name,
	);

	expect(outcome).toEqual({ refused: true, code: "plugin.package_entry_unsupported" });
});

test("device nodes and FIFOs are refused as unsupported entries", async () => {
	for (const typeflag of ["3", "4", "6"]) {
		const name = sentinel();
		const outcome = await expectContained(
			buildTar([
				{ name: "plugin.json", data: PLUGIN_MANIFEST },
				{ name: `special-${typeflag}`, typeflag },
			]),
			name,
		);

		expect(outcome).toEqual({ refused: true, code: "plugin.package_entry_unsupported" });
	}
});

test("zip members with absolute or traversing names are refused as unsafe paths", async () => {
	const name = sentinel();
	for (const member of [`/${join(tmpdir(), name).replace(LEADING_SLASH, "")}`, `../${name}`, `..\\${name}`, `dir/../../${name}`]) {
		const archive = new Uint8Array(zipSync({ "plugin.json": PLUGIN_MANIFEST, [member]: strToU8("zip escape") }));

		expect(await expectContained(archive, name)).toEqual({ refused: true, code: "plugin.package_path_unsafe" });
	}
});

test("zip members with NUL bytes in their names are refused as unsafe paths", async () => {
	const name = sentinel();
	const archive = new Uint8Array(zipSync({ "plugin.json": PLUGIN_MANIFEST, "bad\u0000name.txt": strToU8("x") }));

	expect(await expectContained(archive, name)).toEqual({ refused: true, code: "plugin.package_path_unsafe" });
});

test("a plugin.json below the manifest search depth is refused as missing, one within it is found", async () => {
	const within = await extractPluginPackage(await writeArchive(new Uint8Array(zipSync({ "a/b/c/plugin.json": PLUGIN_MANIFEST }))));
	try {
		expect(within.pluginRoot.endsWith(join("a", "b", "c"))).toBe(true);
	} finally {
		await within.cleanup();
	}

	const beyond = await writeArchive(new Uint8Array(zipSync({ "a/b/c/d/plugin.json": PLUGIN_MANIFEST })));

	await expect(extractPluginPackage(beyond)).rejects.toMatchObject({ code: "plugin.manifest_missing" });
});

test("a package with thousands of small members extracts every member", async () => {
	const files: Record<string, Uint8Array> = { "plugin.json": PLUGIN_MANIFEST, "index.mjs": PLUGIN_ENTRY };
	for (let index = 0; index < 3000; index += 1) files[`assets/file-${index}.txt`] = strToU8(`asset ${index}`);
	const extracted = await extractPluginPackage(await writeArchive(new Uint8Array(zipSync(files))));
	try {
		expect(await readdir(join(extracted.pluginRoot, "assets"))).toHaveLength(3000);
	} finally {
		await extracted.cleanup();
	}
});

test("a packaged plugin.json that is a directory is refused as a missing manifest", async () => {
	const archive = buildTar([
		{ name: "plugin.json/", typeflag: "5" },
		{ name: "index.mjs", data: PLUGIN_ENTRY },
	]);

	await expect(extractPluginPackage(await writeArchive(archive))).rejects.toMatchObject({ code: "plugin.manifest_missing" });
});

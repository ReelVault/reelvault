import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { extractPluginPackage } from "@/plugins/catalog/plugin-package.utils";
import { DomainError } from "@/utils/errors";

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
	await Promise.all(created.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
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

test("tar entries that climb out of the root are refused or stay inside it", async () => {
	const name = sentinel();
	const outcome = await expectContained(buildTar([{ name: `../${name}`, data: strToU8("escape") }]), name);
	expect(outcome.refused).toBe(true);
});

test("tar entries with an absolute path are refused and write nothing", async () => {
	const name = sentinel();
	const outcome = await expectContained(
		buildTar([{ name: `/${join(tmpdir(), name).replace(LEADING_SLASH, "")}`, data: strToU8("absolute") }]),
		name,
	);
	expect(outcome.refused).toBe(true);
});

test("a PAX header that rewrites the path of the next member cannot escape the root", async () => {
	const name = sentinel();
	const archive = buildTar([
		{ name: "PaxHeader", typeflag: "x", data: paxPathRecord(`../${name}`) },
		{ name: "plugin.json", data: PLUGIN_MANIFEST },
		{ name: "index.mjs", data: PLUGIN_ENTRY },
	]);
	await expectContained(archive, name);
});

test("hard links to files outside the root are refused", async () => {
	const name = sentinel();
	const outcome = await expectContained(
		buildTar([
			{ name: "plugin.json", data: PLUGIN_MANIFEST },
			{ name: "link-to-host", typeflag: "1", linkname: `../${name}` },
			{ name: "link-to-passwd", typeflag: "1", linkname: "/etc/passwd" },
		]),
		name,
	);
	expect(outcome.refused).toBe(true);
});

test("device nodes and FIFOs are refused", async () => {
	for (const typeflag of ["3", "4", "6"]) {
		const name = sentinel();
		const outcome = await expectContained(
			buildTar([
				{ name: "plugin.json", data: PLUGIN_MANIFEST },
				{ name: `special-${typeflag}`, typeflag },
			]),
			name,
		);
		expect(outcome.refused).toBe(true);
	}
});

test("zip members with absolute or traversing names never land outside the root", async () => {
	const name = sentinel();
	for (const member of [`/${join(tmpdir(), name).replace(LEADING_SLASH, "")}`, `../${name}`, `..\\${name}`, `dir/../../${name}`]) {
		const archive = new Uint8Array(zipSync({ "plugin.json": PLUGIN_MANIFEST, [member]: strToU8("zip escape") }));
		await expectContained(archive, name);
	}
});

test("zip members with NUL bytes or control characters in their names are refused as unsafe paths", async () => {
	const name = sentinel();
	const archive = new Uint8Array(
		zipSync({ "plugin.json": PLUGIN_MANIFEST, "bad\u0000name.txt": strToU8("x"), "tab\tname.txt": strToU8("y") }),
	);

	expect(await expectContained(archive, name)).toEqual({ refused: true, code: "plugin.package_path_unsafe" });
});

test("a deeply nested package is extracted or refused without exhausting the stack", async () => {
	const name = sentinel();
	const deep = `${Array.from({ length: 80 }, (_, index) => `level-${index}`).join("/")}/note.txt`;
	const archive = new Uint8Array(zipSync({ "plugin.json": PLUGIN_MANIFEST, [deep]: strToU8("deep") }));
	await expectContained(archive, name);
});

test("a package with thousands of small members extracts within a bounded time", async () => {
	const name = sentinel();
	const files: Record<string, Uint8Array> = { "plugin.json": PLUGIN_MANIFEST, "index.mjs": PLUGIN_ENTRY };
	for (let index = 0; index < 3000; index += 1) files[`assets/file-${index}.txt`] = strToU8(`asset ${index}`);
	const archivePath = await writeArchive(new Uint8Array(zipSync(files)));
	const started = performance.now();

	const extracted = await extractPluginPackage(archivePath);
	await extracted.cleanup();

	expect(performance.now() - started).toBeLessThan(15_000);
	expect(existsSync(join(tmpdir(), name))).toBe(false);
});

test("a packaged plugin.json that is not a file is refused as a missing manifest", async () => {
	const archive = buildTar([
		{ name: "plugin.json/", typeflag: "5" },
		{ name: "index.mjs", data: PLUGIN_ENTRY },
	]);
	const archivePath = await writeArchive(archive);

	await expect(extractPluginPackage(archivePath)).rejects.toBeInstanceOf(DomainError);
	expect((await stat(archivePath)).isFile()).toBe(true);
});

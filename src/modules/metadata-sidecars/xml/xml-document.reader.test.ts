import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { loadXmlDocumentFile, readXmlDocument } from "./xml-document.reader";

describe("loadXmlDocumentFile", () => {
	test("parses a document from disk and reports a missing file as null", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-xml-reader-"));
		const documentPath = join(directory, "movie.nfo");
		try {
			await writeFile(documentPath, "<movie><title>From disk</title></movie>");

			const document = await loadXmlDocumentFile(documentPath);
			expect(document?.values).toEqual({ movie: { title: "From disk" } });
			expect(await loadXmlDocumentFile(join(directory, "missing.nfo"))).toBeNull();
		} finally {
			await removeTree(directory);
		}
	});

	test("uses the supplied body without reading the path again", async () => {
		const document = await loadXmlDocumentFile("/does/not/exist.nfo", "<movie><title>Supplied</title></movie>");

		expect(document?.values).toEqual({ movie: { title: "Supplied" } });
	});
});

describe("readXmlDocument", () => {
	test("parses a normal sidecar document and decodes predefined entities", async () => {
		const document = await readXmlDocument("<movie><title>Hello &amp; World</title></movie>");
		expect(document?.values).toEqual({ movie: { title: "Hello & World" } });
	});

	test("rejects documents declaring a DTD or custom entity", async () => {
		expect(await readXmlDocument(`<!DOCTYPE foo [<!ENTITY x "y">]><foo>&x;</foo>`)).toBeNull();
		expect(await readXmlDocument(`<!ENTITY x "y"><foo>&x;</foo>`)).toBeNull();
	});

	test("rejects malformed XML", async () => {
		expect(await readXmlDocument("<movie><title>oops</movie>")).toBeNull();
	});
});
